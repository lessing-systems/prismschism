package parser

import (
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	dto "github.com/prometheus/client_model/go"
	"github.com/prometheus/common/expfmt"
)

// Result is the output of a single Parse call.
type Result struct {
	Rows            []Row
	SeriesCount     int
	TripwireTripped bool
}

// Tripwire bounds the cardinality of a scrape: it tolerates a series count up
// to factor times its observed baseline, and trips (dropping the excess)
// once the count exceeds that bound. It is safe for concurrent use.
type Tripwire struct {
	mu       sync.Mutex
	baseline int
	factor   int
}

// NewTripwire returns a Tripwire that trips when the series count exceeds
// factor times its rolling-max baseline.
func NewTripwire(factor int) *Tripwire {
	return &Tripwire{factor: factor}
}

// Check applies the tripwire to count.
//
//   - First observation: the count becomes the baseline; nothing trips.
//   - Thereafter: if count > factor*baseline the tripwire trips and the
//     caller may emit at most factor*baseline rows; otherwise the count is
//     allowed as-is.
//
// After every check the baseline is raised to max(baseline, count), so it
// tracks the rolling maximum and the bound grows with observed growth.
// Returns (tripped, allowed).
func (tw *Tripwire) Check(count int) (bool, int) {
	tw.mu.Lock()
	defer tw.mu.Unlock()

	if tw.baseline == 0 {
		tw.baseline = count
		return false, count
	}

	bound := tw.factor * tw.baseline
	tripped := count > bound
	if tripped {
		log.Printf("CARDINALITY TRIPWIRE: %d series > %dx baseline %d — dropping excess",
			count, tw.factor, tw.baseline)
	}

	// Rolling max: never let the baseline shrink below a previously seen peak.
	if count > tw.baseline {
		tw.baseline = count
	}

	if tripped {
		return true, bound
	}
	return false, count
}

// Parse converts a Prometheus text exposition into raw-tier Rows.
//
// ts is stamped onto every emitted Row. tw bounds cardinality (see Tripwire).
//
// Processing order (deterministic):
//  1. Parse all metric families with expfmt.TextParser.
//  2. Iterate families in sorted-name order.
//  3. Count EVERY Prometheus series — each LabelPair combination, including
//     histogram buckets and summary quantiles — into SeriesCount BEFORE any
//     filtering, so the tripwire sees true cardinality.
//  4. Apply the tripwire to SeriesCount to get the emission budget; emit rows
//     only up to that budget (the excess is dropped but still counted in
//     SeriesCount).
//  5. Unknown families (not in the explicit map) are logged and skipped (they
//     still count toward SeriesCount).
func Parse(text string, ts time.Time, tw *Tripwire) (*Result, error) {
	families, err := (&expfmt.TextParser{}).TextToMetricFamilies(strings.NewReader(text))
	if err != nil {
		return nil, fmt.Errorf("parse metric families: %w", err)
	}

	// Deterministic iteration order.
	names := make([]string, 0, len(families))
	for name := range families {
		names = append(names, name)
	}
	sort.Strings(names)

	res := &Result{}

	// Step 3: count every series before filtering.
	for _, name := range names {
		res.SeriesCount += seriesCountFor(families[name])
	}

	// Step 4: tripwire budget.
	tripped, allowed := tw.Check(res.SeriesCount)
	res.TripwireTripped = tripped

	emitted := 0
	// skippedEmptyModel counts requests-family rows dropped because their
	// effective Model is empty — the proxy's own /metrics self-traffic
	// (requested_model="", route="/metrics"). Logged once after the loop.
	skippedEmptyModel := 0
	// skippedHealthCheck counts rows dropped because LiteLLM's background health
	// checker produced them (hashed_api_key == healthCheckKey). They are not
	// client traffic and carry the raw upstream model name, which would
	// otherwise surface as a phantom front-end model.
	skippedHealthCheck := 0
	for _, name := range names {
		if emitted >= allowed {
			break
		}
		family, ok := familyFor(name)
		if !ok {
			log.Printf("skipping metric %q (not in explicit map)", name)
			continue
		}
		for _, m := range families[name].GetMetric() {
			for _, r := range metricToRows(families[name], m, ts, family, name) {
				if emitted >= allowed {
					break
				}
				// Drop the proxy's own /metrics self-traffic: a requests-family
				// row whose effective Model is empty. Other families keep their
				// empty-model rows untouched.
				if r.Family == "requests" && r.Model == "" {
					skippedEmptyModel++
					continue
				}
				if r.HashedAPIKey == healthCheckKey {
					skippedHealthCheck++
					continue
				}
				res.Rows = append(res.Rows, r)
				emitted++
			}
		}
	}
	if skippedEmptyModel > 0 {
		log.Printf("skipping %d requests row(s) with empty effective model", skippedEmptyModel)
	}

	if skippedHealthCheck > 0 {
		log.Printf("skipping %d row(s) from LiteLLM internal health checks", skippedHealthCheck)
	}

	return res, nil
}

// healthCheckKey is the hashed_api_key / api_key_alias LiteLLM stamps on the
// requests its own health checker sends to each deployment.
const healthCheckKey = "litellm-internal-health-check"

// seriesCountFor returns the number of Prometheus series represented by a
// metric family. Histograms and summaries contribute more than len(Metric)
// because each metric also owns one _sum, one _count, plus one series per
// bucket (histogram) or per quantile (summary).
func seriesCountFor(mf *dto.MetricFamily) int {
	n := 0
	for _, m := range mf.GetMetric() {
		switch mf.GetType() {
		case dto.MetricType_HISTOGRAM:
			n += len(m.GetHistogram().GetBucket()) + 2
		case dto.MetricType_SUMMARY:
			n += len(m.GetSummary().GetQuantile()) + 2
		default:
			n++
		}
	}
	return n
}

// metricToRows turns one proto metric into zero or more Rows for the given
// family and metric name.
//
//   - COUNTER / GAUGE / UNTYPED: exactly one Row, Value from the type's value,
//     Unit = the metric's unit label ("unit" then "units") else defaultUnit.
//     MetricName = base name, IsCounter = true for counter, false for gauge.
//   - HISTOGRAM / SUMMARY: only the _sum and _count series become Rows (a
//     _sum row and a _count row). Bucket and quantile samples are skipped.
//     MetricName = base+"_sum" or base+"_count", IsCounter = true.
func metricToRows(mf *dto.MetricFamily, m *dto.Metric, ts time.Time, family string, baseName string) []Row {
	switch mf.GetType() {
	case dto.MetricType_COUNTER:
		return []Row{buildRow(m.GetLabel(), ts, family, baseName, true,
			m.GetCounter().GetValue(), unitOr(m.GetLabel(), family))}
	case dto.MetricType_GAUGE:
		return []Row{buildRow(m.GetLabel(), ts, family, baseName, false,
			m.GetGauge().GetValue(), unitOr(m.GetLabel(), family))}
	case dto.MetricType_UNTYPED:
		return []Row{buildRow(m.GetLabel(), ts, family, baseName, false,
			m.GetUntyped().GetValue(), unitOr(m.GetLabel(), family))}
	case dto.MetricType_HISTOGRAM, dto.MetricType_SUMMARY:
		sumName := baseName + "_sum"
		countName := baseName + "_count"
		return []Row{
			// _sum row. Unit: explicit unit label, else the family default
			// suffixed with "_sum".
			buildRow(m.GetLabel(), ts, family, sumName, true,
				metricSum(m), sumUnit(m.GetLabel(), family)),
			// _count row.
			buildRow(m.GetLabel(), ts, family, countName, true,
				metricCount(m), "count"),
		}
	}
	return nil
}

// metricSum returns the _sum value of a histogram or summary metric.
func metricSum(m *dto.Metric) float64 {
	if h := m.GetHistogram(); h != nil {
		return h.GetSampleSum()
	}
	if s := m.GetSummary(); s != nil {
		return s.GetSampleSum()
	}
	return 0
}

// metricCount returns the _count (sample count) of a histogram or summary
// metric as a float64.
func metricCount(m *dto.Metric) float64 {
	if h := m.GetHistogram(); h != nil {
		return float64(h.GetSampleCount())
	}
	if s := m.GetSummary(); s != nil {
		return float64(s.GetSampleCount())
	}
	return 0
}

// unitOr returns the series' unit label if present, else the family default.
func unitOr(labels []*dto.LabelPair, family string) string {
	if u := unitFromLabels(labels); u != "" {
		return u
	}
	return defaultUnit(family)
}

// sumUnit returns the unit for a _sum series: the explicit unit label, else
// the family default suffixed with "_sum".
func sumUnit(labels []*dto.LabelPair, family string) string {
	if u := unitFromLabels(labels); u != "" {
		return u
	}
	return defaultUnit(family) + "_sum"
}
