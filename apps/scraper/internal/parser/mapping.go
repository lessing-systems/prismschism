// Package parser converts a Prometheus text exposition into raw-tier Row
// records for the litellm scraper.
//
// This file (mapping.go) is the SINGLE, clearly-commented mapping source of
// truth: it defines the Row shape, classifies every litellm_* metric name into
// a storage "family" via an explicit map (SSOT), chooses the default unit per
// family, and decides which Prometheus labels are kept versus dropped when
// building a Row.
//
// Security contract: Row carries only non-secret label values (model, team,
// hashed_api_key, api_key_alias, user). The plaintext api_base / client_ip /
// user_agent / user_email / end_user labels are never stored, and nothing in
// this package ever logs a secret value.
package parser

import (
	"sort"
	"strings"
	"sync/atomic"
	"time"

	dto "github.com/prometheus/client_model/go"
)

// Family constants: the storage families the eleven LiteLLM token counters are
// split into (the five token families), plus FamilyRequests — the "requests"
// storage family, which resolveGroup treats as deployment-scoped alongside the
// token families. Each family keeps the original metric name on the row
// (Row.MetricName → stored "metric" column), so distinct counters within one
// family are never merged.
const (
	FamilyInputTokens     = "input_tokens"
	FamilyOutputTokens    = "output_tokens"
	FamilyReasoningTokens = "reasoning_tokens"
	FamilyCachedTokens    = "cached_tokens"
	FamilyTotalTokens     = "total_tokens"
	FamilyRequests        = "requests"
)

// Row is one raw-tier record produced from a single scraped metric series.
//
// Family is one of the five token families (input_tokens, output_tokens,
// reasoning_tokens, cached_tokens, total_tokens) or one of "latency",
// "requests", "spend", "limits", "deployment_health", "counters" (see
// metricFamily). It is the storage-side grouping key the raw table is
// partitioned by.
//
// MetricName is the exact Prometheus metric name (for histograms, the base
// name with "_sum" or "_count" suffix). IsCounter indicates whether the value
// is monotonically increasing (counter or histogram/summary _sum/_count).
type Row struct {
	TS         time.Time
	MetricName string
	IsCounter  bool
	Model      string
	ModelID    string
	// LitellmModelName is the deployment-side model name (the
	// litellm_model_name label). Populated ONLY for the deployment_health
	// family, where it forms half of the composite series key with ModelID.
	LitellmModelName string
	// ExceptionStatus is the exception_status label. Populated ONLY for the
	// counters family, where it differentiates sibling event-counter series.
	ExceptionStatus string
	// ExceptionClass is the exception_class label. Populated ONLY for the
	// requests family, where it differentiates sibling request-counter series
	// (it appears alongside exception_status on
	// litellm_proxy_failed_requests_metric_total) so they stop colliding on the
	// delta tracker.
	ExceptionClass string
	// Route is the route label (e.g. "/v1/chat/completions"). Populated ONLY
	// for the requests family, where it differentiates sibling request-counter
	// series so they stop colliding on the delta tracker.
	Route string
	// StatusCode is the status_code label (e.g. "200", "576"). Populated ONLY
	// for the requests family, where it differentiates sibling request-counter
	// series so they stop colliding on the delta tracker.
	StatusCode string
	// Status is the normalised deployment health status string
	// ("healthy" / "error"). Populated ONLY for the deployment_health family.
	Status       string
	APIProvider  string
	Value        float64
	Unit         string
	HashedAPIKey string
	APIKeyAlias  string
	User         string
	Team         string
	Family       string
	// SeriesLabels is the FULL sorted "name=value" label set of the source
	// Prometheus series, captured at parse time. It exists purely so the delta
	// tracker's series key can never collide two distinct source series whose
	// difference lives in a label the storage schema drops: the requests
	// family carries client_ip, and two client IPs hitting the same deployment
	// used to alternate one tracker key, producing garbage deltas (measured
	// ~13k req/min on a card where the true rate was double digits). It is an
	// in-memory key ingredient ONLY — it is never written to the database and
	// never logged (the security contract below is untouched).
	SeriesLabels string
}

// SeriesKey returns the deterministic series identifier used by the delta
// tracker and store.
//
// When the Row carries SeriesLabels (every parser-built Row does), the key is
// "Family|MetricName|<full sorted label set>" — the FULL label set, including
// labels that are dropped from storage, so two source series that differ only
// in a dropped label (client_ip on the requests family) can never share one
// delta-tracker key again.
//
// Rows built without SeriesLabels (legacy/tests) fall back to the historical
// format: the 12 canonical labels (api_key_alias, api_provider,
// exception_class, exception_status, hashed_api_key, litellm_model_name,
// model, model_id, route, status_code, team, user) filtered to non-empty
// values, sorted by label NAME (lexicographic), and joined with commas.
func (r Row) SeriesKey() string {
	if r.SeriesLabels != "" {
		return r.Family + "|" + r.MetricName + "|" + r.SeriesLabels
	}
	parts := make([][2]string, 0, 12)
	if r.APIKeyAlias != "" {
		parts = append(parts, [2]string{"api_key_alias", r.APIKeyAlias})
	}
	if r.APIProvider != "" {
		parts = append(parts, [2]string{"api_provider", r.APIProvider})
	}
	if r.ExceptionStatus != "" {
		parts = append(parts, [2]string{"exception_status", r.ExceptionStatus})
	}
	if r.ExceptionClass != "" {
		parts = append(parts, [2]string{"exception_class", r.ExceptionClass})
	}
	if r.HashedAPIKey != "" {
		parts = append(parts, [2]string{"hashed_api_key", r.HashedAPIKey})
	}
	if r.LitellmModelName != "" {
		parts = append(parts, [2]string{"litellm_model_name", r.LitellmModelName})
	}
	if r.Model != "" {
		parts = append(parts, [2]string{"model", r.Model})
	}
	if r.ModelID != "" {
		parts = append(parts, [2]string{"model_id", r.ModelID})
	}
	if r.Route != "" {
		parts = append(parts, [2]string{"route", r.Route})
	}
	if r.StatusCode != "" {
		parts = append(parts, [2]string{"status_code", r.StatusCode})
	}
	if r.Team != "" {
		parts = append(parts, [2]string{"team", r.Team})
	}
	if r.User != "" {
		parts = append(parts, [2]string{"user", r.User})
	}
	// Already appended in sorted-by-name order (api_key_alias < api_provider <
	// exception_class < exception_status < hashed_api_key < litellm_model_name <
	// model < model_id < route < status_code < team < user).
	// Verify sort (defensive):
	sort.Slice(parts, func(i, j int) bool { return parts[i][0] < parts[j][0] })

	key := r.Family + "|" + r.MetricName
	if len(parts) > 0 {
		labels := make([]string, len(parts))
		for i, p := range parts {
			labels[i] = p[0] + "=" + p[1]
		}
		key += "|" + strings.Join(labels, ",")
	}
	return key
}

// metricFamily is the EXPLICIT, authoritative metric-name → storage-family map.
//
// This is the SINGLE SOURCE OF TRUTH for classification. Anything not present
// here is skipped (log-and-drop). The map is derived from:
//   - the LiteLLM Prometheus metric catalog
//   - infra/db/migrations/001_schema.sql family whitelist
//   - live 94-metric TYPE catalog from a LiteLLM /metrics scrape
//
// Check order in familyFor:
//  1. "_created" suffix → skip (belt-and-suspenders; epoch gauges are never
//     stored, even if a name were accidentally added to the map)
//  2. Explicit map lookup → return family
//  3. Not in map → skip
//
// This replaces the previous keyword-heuristic (strings.Contains) approach
// which could misclassify metrics.
var metricFamily = map[string]string{
	// ── token families (11 metrics → 5 families) ─────────────────
	// input_tokens
	"litellm_input_tokens_metric_total":       FamilyInputTokens,
	"litellm_input_audio_tokens_metric_total": FamilyInputTokens,
	// output_tokens
	"litellm_output_tokens_metric_total":       FamilyOutputTokens,
	"litellm_output_audio_tokens_metric_total": FamilyOutputTokens,
	// reasoning_tokens
	"litellm_output_reasoning_tokens_metric_total": FamilyReasoningTokens,
	// cached_tokens
	"litellm_cached_tokens_metric_total":                        FamilyCachedTokens,
	"litellm_input_cached_tokens_metric_total":                  FamilyCachedTokens,
	"litellm_input_cache_creation_tokens_metric_total":          FamilyCachedTokens,
	"litellm_provider_cache_read_input_tokens_metric_total":     FamilyCachedTokens,
	"litellm_provider_cache_creation_input_tokens_metric_total": FamilyCachedTokens,
	// total_tokens
	"litellm_total_tokens_metric_total": FamilyTotalTokens,

	// ── latency (8) ─────────────────────────────────────────────
	"litellm_request_total_latency_metric":            "latency",
	"litellm_llm_api_latency_metric":                  "latency",
	"litellm_llm_api_time_to_first_token_metric":      "latency",
	"litellm_overhead_latency_metric":                 "latency",
	"litellm_overhead_with_guardrails_latency_metric": "latency",
	"litellm_request_queue_time_seconds":              "latency",
	"litellm_guardrail_latency_seconds":               "latency",
	"litellm_deployment_latency_per_output_token":     "latency",

	// ── requests (1) ────────────────────────────────────────────
	// ONLY litellm_requests_metric_total is stored. The other request
	// counters were dropped deliberately: they DOUBLE-COUNT the same requests
	// (litellm_proxy_total_requests_metric_total advances in lockstep with it
	// for every request), and the requests storage schema has no metric
	// column, so the API's SUM(value) per bucket would count every request
	// twice (or worse with the failed-counter variants). Measured on a real
	// fleet: ~13k req/min on a card whose true rate was double digits.
	"litellm_requests_metric_total": "requests",

	// ── spend (1) ───────────────────────────────────────────────
	"litellm_spend_metric_total": "spend",

	// ── limits (14) ─────────────────────────────────────────────
	"litellm_remaining_tokens_metric":              "limits",
	"litellm_remaining_requests_metric":            "limits",
	"litellm_remaining_api_key_budget_metric":      "limits",
	"litellm_remaining_team_budget_metric":         "limits",
	"litellm_remaining_user_budget_metric":         "limits",
	"litellm_remaining_org_budget_metric":          "limits",
	"litellm_deployment_rpm_limit":                 "limits",
	"litellm_deployment_tpm_limit":                 "limits",
	"litellm_remaining_api_key_requests_for_model": "limits",
	"litellm_remaining_api_key_tokens_for_model":   "limits",
	"litellm_api_key_rate_limit_allowed_metric":    "limits",
	"litellm_api_key_rate_limit_used_metric":       "limits",
	"litellm_team_rate_limit_allowed_metric":       "limits",
	"litellm_team_rate_limit_used_metric":          "limits",

	// -- deployment_health (1) --
	// Real deployment health state from the litellm_deployment_state gauge,
	// composite-keyed by (model_id, litellm_model_name). NOT a traffic-light
	// derivation and NOT instance scrape health.
	"litellm_deployment_state": "deployment_health",

	// -- counters (1) --
	// Generic low-cardinality event counters, differentiated by the
	// exception_status label. Not health state.
	"litellm_deployment_cooled_down_total": "counters",
}

// familyFor classifies a Prometheus metric name into a storage family.
//
// Check order is significant and fixed:
//  1. "_created" suffix → skip (epoch gauges are never stored)
//  2. Explicit map lookup (metricFamily) → return family
//  3. Not in map → skip (log-and-drop)
func familyFor(name string) (string, bool) {
	// Belt-and-suspenders: _created gauges carry unix epoch timestamps (~1.79e9)
	// and must NEVER be stored, regardless of whether their name is in the map.
	if strings.HasSuffix(name, "_created") {
		return "", false
	}
	if fam, ok := metricFamily[name]; ok {
		return fam, true
	}
	return "", false
}

// defaultUnit returns the storage unit label used for a family when the metric
// carries neither a "unit" nor a "units" label.
func defaultUnit(family string) string {
	switch family {
	case FamilyInputTokens, FamilyOutputTokens, FamilyReasoningTokens,
		FamilyCachedTokens, FamilyTotalTokens:
		return "tokens"
	case "latency":
		return "s"
	case "requests":
		return "count"
	case "spend":
		return "usd"
	case "limits":
		return "ratio"
	}
	return ""
}

// labelValue returns the value of the named label, or "" if absent.
func labelValue(labels []*dto.LabelPair, name string) string {
	for _, lp := range labels {
		if lp.GetName() == name {
			return lp.GetValue()
		}
	}
	return ""
}

// modelFor resolves the effective model grouping for a series.
//
// It delegates to resolveGroup, which applies its resolution order: the
// "requested_model" label when present; the raw "model" label for
// non-deployment-scoped families or deployment-scoped families (token families
// plus requests) without a model_id; the inventory logical group
// for a matching model_id; otherwise the "unassigned" bucket. litellm_model_name
// is NOT used (it is a deployment-side name, not a request-side name).
func modelFor(labels []*dto.LabelPair, family string) string {
	return resolveGroup(labels, family)
}

// groupLookup, when installed, resolves a physical model_id back to its logical
// model group using the deployment inventory. Installed once at startup by
// main via SetGroupLookup; nil means "no inventory wired yet". Stored in an
// atomic.Value so the scrape loop never races the setter.
var groupLookup atomic.Value

// SetGroupLookup installs the model_id -> model_group resolver used by modelFor.
func SetGroupLookup(fn func(modelID string) (string, bool)) {
	if fn == nil {
		groupLookup.Store((*func(string) (string, bool))(nil))
		return
	}
	groupLookup.Store(&fn)
}

// modelGroupFor resolves the logical group for a physical model_id.
// Returns ("", false) when no resolver is installed or the id is unknown.
func modelGroupFor(modelID string) (string, bool) {
	if modelID == "" {
		return "", false
	}
	p, ok := groupLookup.Load().(*func(string) (string, bool))
	if !ok || p == nil {
		return "", false
	}
	return (*p)(modelID)
}

// seriesLabels renders the FULL label set of a series as sorted name=value
// pairs joined by commas. Unlike the kept-label set this includes labels that
// are never stored (client_ip, user_agent, end_user, org_*), so the delta
// tracker's key distinguishes every source series.
func seriesLabels(labels []*dto.LabelPair) string {
	parts := make([]string, 0, len(labels))
	for _, lp := range labels {
		parts = append(parts, lp.GetName()+"="+lp.GetValue())
	}
	sort.Strings(parts)
	return strings.Join(parts, ",")
}

// buildRow turns a metric series' labels into a Row for the given family,
// value and unit.
//
// name is the metric name (for histograms: base+"_sum" or base+"_count").
// isCounter indicates whether the value is a counter (monotonically increasing).
//
// Label mapping — KEPT and populated onto Row:
//
//	model, model_id, api_provider, api_key_alias, hashed_api_key, user, team
//
// DROPPED (simply never read, so they can never end up in a Row):
//
//	client_ip, user_agent, user_email, end_user
//
// api_base: STRIPPED from all stored metric families.
func buildRow(labels []*dto.LabelPair, ts time.Time, family string, name string, isCounter bool, value float64, unit string) Row {
	r := Row{
		TS:           ts,
		MetricName:   name,
		IsCounter:    isCounter,
		Model:        modelFor(labels, family),
		ModelID:      labelValue(labels, "model_id"),
		APIProvider:  labelValue(labels, "api_provider"),
		HashedAPIKey: labelValue(labels, "hashed_api_key"),
		APIKeyAlias:  labelValue(labels, "api_key_alias"),
		User:         labelValue(labels, "user"),
		Team:         labelValue(labels, "team"),
		Value:        value,
		Unit:         unit,
		Family:       family,
		SeriesLabels: seriesLabels(labels),
	}

	// Family-scoped label population. ONLY these three families read the
	// deployment-side / exception / request-differentiating labels, so the
	// SeriesKey of every other family is unchanged.
	switch family {
	case "deployment_health":
		// Composite identity: (model_id, litellm_model_name). The gauge's
		// numeric 0/1/2 becomes the stored status string.
		r.LitellmModelName = labelValue(labels, "litellm_model_name")
		r.Status = valueToStatus(value)
	case "counters":
		// exception_status is the differentiating label of the generic
		// counters family; litellm_model_name is deliberately NOT read here.
		r.ExceptionStatus = labelValue(labels, "exception_status")
	case "requests":
		// The requests family carries three differentiating labels that the
		// delta tracker needs to keep sibling request-counter series distinct
		// (same model/provider, different status_code / route / exception_class).
		// Read ONLY here, so every other family's SeriesKey stays byte-identical.
		r.StatusCode = labelValue(labels, "status_code")
		r.Route = labelValue(labels, "route")
		r.ExceptionClass = labelValue(labels, "exception_class")
	}
	return r
}

// valueToStatus normalises the litellm_deployment_state gauge value into the
// closed status vocabulary stored in deployment_health.status.
//
// Caller decision: 0 -> "healthy"; every non-zero value (1 = partial outage,
// 2 = under maintenance) collapses to "error". The dashboard only
// distinguishes healthy from not-healthy, so "prefill", "partial" and "down"
// are NEVER emitted by the scraper.
func valueToStatus(v float64) string {
	if v == 0 {
		return "healthy"
	}
	return "error"
}

// unitFromLabels returns the unit label of a series, looking for "unit" first
// then "units".
func unitFromLabels(labels []*dto.LabelPair) string {
	if u := labelValue(labels, "unit"); u != "" {
		return u
	}
	return labelValue(labels, "units")
}
