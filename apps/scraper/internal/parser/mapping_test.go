package parser

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// TestMetricFamilyMap tests the explicit metric-name to family map (SSOT).
// Every entry that should be stored is asserted to map to the correct family.
// Every entry that should be skipped is asserted to return ok=false.
func TestMetricFamilyMap(t *testing.T) {
	mapped := map[string]string{
		"litellm_input_tokens_metric_total":                         "input_tokens",
		"litellm_input_audio_tokens_metric_total":                   "input_tokens",
		"litellm_output_tokens_metric_total":                        "output_tokens",
		"litellm_output_audio_tokens_metric_total":                  "output_tokens",
		"litellm_output_reasoning_tokens_metric_total":              "reasoning_tokens",
		"litellm_cached_tokens_metric_total":                        "cached_tokens",
		"litellm_input_cached_tokens_metric_total":                  "cached_tokens",
		"litellm_input_cache_creation_tokens_metric_total":          "cached_tokens",
		"litellm_provider_cache_read_input_tokens_metric_total":     "cached_tokens",
		"litellm_provider_cache_creation_input_tokens_metric_total": "cached_tokens",
		"litellm_total_tokens_metric_total":                         "total_tokens",
		"litellm_request_total_latency_metric":                      "latency",
		"litellm_llm_api_latency_metric":                            "latency",
		"litellm_llm_api_time_to_first_token_metric":                "latency",
		"litellm_overhead_latency_metric":                           "latency",
		"litellm_overhead_with_guardrails_latency_metric":           "latency",
		"litellm_request_queue_time_seconds":                        "latency",
		"litellm_guardrail_latency_seconds":                         "latency",
		"litellm_deployment_latency_per_output_token":               "latency",
		// FIX (requests double-count): only litellm_requests_metric_total is
		// stored. The proxy/failed request counters advance in lockstep with it
		// for the same requests, and the requests schema has no metric column,
		// so SUM(value) per bucket counted every request at least twice.
		"litellm_requests_metric_total":                             "requests",
		"litellm_spend_metric_total":                                "spend",
		"litellm_remaining_tokens_metric":                           "limits",
		"litellm_remaining_requests_metric":                         "limits",
		"litellm_remaining_api_key_budget_metric":                   "limits",
		"litellm_remaining_team_budget_metric":                      "limits",
		"litellm_remaining_user_budget_metric":                      "limits",
		"litellm_remaining_org_budget_metric":                       "limits",
		"litellm_deployment_rpm_limit":                              "limits",
		"litellm_deployment_tpm_limit":                              "limits",
		"litellm_remaining_api_key_requests_for_model":              "limits",
		"litellm_remaining_api_key_tokens_for_model":                "limits",
		"litellm_api_key_rate_limit_allowed_metric":                 "limits",
		"litellm_api_key_rate_limit_used_metric":                    "limits",
		"litellm_team_rate_limit_allowed_metric":                    "limits",
		"litellm_team_rate_limit_used_metric":                       "limits",
		// Newly landed metrics (previously in the skipped slice).
		"litellm_deployment_state":             "deployment_health",
		"litellm_deployment_cooled_down_total": "counters",
	}
	for name, wantFamily := range mapped {
		gotFamily, ok := familyFor(name)
		if !ok {
			t.Errorf("familyFor(%q): ok=false, want true (family %q)", name, wantFamily)
		} else if gotFamily != wantFamily {
			t.Errorf("familyFor(%q) = %q, want %q", name, gotFamily, wantFamily)
		}
	}

	skipped := []string{
		// FIX (requests double-count): the overlapping request counters are no
		// longer stored — see the mapped-block comment above.
		"litellm_proxy_total_requests_metric_total",
		"litellm_proxy_failed_requests_metric_total",
		"litellm_llm_api_failed_requests_metric_total",
		"litellm_proxy_total_requests_metric_created",
		"litellm_spend_metric_created",
		"litellm_input_tokens_metric_created",
		"litellm_total_tokens_metric_created",
		"litellm_deployment_latency_per_output_token_created",
		"litellm_request_total_latency_metric_created",
		"litellm_deployment_total_requests_total",
		"litellm_deployment_success_responses_total",
		"litellm_deployment_failure_responses_total",
		"litellm_cache_hits_metric_total",
		"litellm_cache_misses_metric_total",
		"litellm_in_flight_requests",
		"litellm_guardrail_requests_total",
		"litellm_guardrail_errors_total",
		"litellm_team_members_metric",
		"litellm_mcp_tool_calls_total",
		"litellm_mystery_thing",
		"litellm_random_thing",
		"process_start_time_seconds",
		"litellm_api_key_budget_remaining_hours_metric",
		"litellm_api_key_max_budget_metric",
		"litellm_org_budget_remaining_hours_metric",
	}
	for _, name := range skipped {
		gotFamily, ok := familyFor(name)
		if ok {
			t.Errorf("familyFor(%q) = (%q,true), want skip", name, gotFamily)
		}
	}
}

// TestDefaultUnitTokenFamilies verifies each of the five token families
// defaults to unit "tokens" and the retired merged "tokens" family has no unit.
func TestDefaultUnitTokenFamilies(t *testing.T) {
	for _, fam := range []string{"input_tokens", "output_tokens", "reasoning_tokens", "cached_tokens", "total_tokens"} {
		if got := defaultUnit(fam); got != "tokens" {
			t.Errorf("defaultUnit(%q) = %q, want \"tokens\"", fam, got)
		}
	}
	if got := defaultUnit("tokens"); got != "" {
		t.Errorf("defaultUnit(\"tokens\") = %q, want \"\" (retired merged family)", got)
	}
}

// TestCreatedGaugeGuard verifies the _created suffix check.
func TestCreatedGaugeGuard(t *testing.T) {
	cases := []string{
		"litellm_spend_metric_created",
		"litellm_total_tokens_metric_created",
		"litellm_proxy_total_requests_metric_created",
		"litellm_deployment_latency_per_output_token_created",
		"litellm_request_total_latency_metric_created",
	}
	for _, name := range cases {
		if _, ok := familyFor(name); ok {
			t.Errorf("familyFor(%q): ok=true, want false (_created guard)", name)
		}
	}
}

// TestTokenMetricNamesPreserved verifies the 11 token counters are split across
// the five token families and that distinct metric names are never collapsed:
// SeriesKey embeds the metric name, so two different metrics of the same family
// always yield distinct series keys.
func TestTokenMetricNamesPreserved(t *testing.T) {
	tokenFamilies := map[string]bool{
		"input_tokens": true, "output_tokens": true, "reasoning_tokens": true,
		"cached_tokens": true, "total_tokens": true,
	}
	var metrics []string
	for name, fam := range metricFamily {
		if fam == "tokens" {
			t.Errorf("metric %q still maps to retired merged family \"tokens\"", name)
		}
		if tokenFamilies[fam] {
			metrics = append(metrics, name)
		}
	}
	if len(metrics) != 11 {
		t.Fatalf("token metrics = %d, want 11", len(metrics))
	}
	// All five families must be represented.
	covered := map[string]bool{}
	// Identical labels + different metric names → distinct series keys.
	seen := map[string]string{}
	for _, name := range metrics {
		fam, _ := familyFor(name)
		covered[fam] = true
		r := Row{Family: fam, MetricName: name, Model: "gpt-4", APIProvider: "openai"}
		key := r.SeriesKey()
		if prev, dup := seen[key]; dup {
			t.Errorf("series key collision: %q and %q both produce %q", prev, name, key)
		}
		seen[key] = name
		if !strings.Contains(key, "|"+name+"|") {
			t.Errorf("series key %q does not preserve metric name %q", key, name)
		}
	}
	for fam := range tokenFamilies {
		if !covered[fam] {
			t.Errorf("token family %q has no metrics mapped to it", fam)
		}
	}
}

// TestSeriesKey verifies the exact format of Row.SeriesKey().
func TestSeriesKey(t *testing.T) {
	cases := []struct {
		name string
		row  Row
		want string
	}{
		{
			name: "no labels",
			row:  Row{Family: "requests", MetricName: "litellm_proxy_total_requests_metric_total"},
			want: "requests|litellm_proxy_total_requests_metric_total",
		},
		{
			name: "single label",
			row:  Row{Family: "input_tokens", MetricName: "litellm_input_tokens_metric_total", Model: "gpt-4"},
			want: "input_tokens|litellm_input_tokens_metric_total|model=gpt-4",
		},
		{
			name: "multiple labels sorted by name",
			row: Row{
				Family:       "output_tokens",
				MetricName:   "litellm_output_tokens_metric_total",
				APIProvider:  "openai",
				HashedAPIKey: "hash123",
				Model:        "gpt-4",
				User:         "alice",
			},
			want: "output_tokens|litellm_output_tokens_metric_total|api_provider=openai,hashed_api_key=hash123,model=gpt-4,user=alice",
		},
		{
			name: "empty values omitted",
			row: Row{
				Family:       "latency",
				MetricName:   "litellm_request_total_latency_metric_sum",
				Model:        "gpt-4",
				HashedAPIKey: "hash456",
			},
			want: "latency|litellm_request_total_latency_metric_sum|hashed_api_key=hash456,model=gpt-4",
		},
		{
			name: "all 7 labels",
			row: Row{
				Family:       "limits",
				MetricName:   "litellm_remaining_tokens_metric",
				APIKeyAlias:  "prod",
				APIProvider:  "anthropic",
				HashedAPIKey: "abc123",
				Model:        "claude-3",
				ModelID:      "cm-42",
				Team:         "eng",
				User:         "bob",
			},
			want: "limits|litellm_remaining_tokens_metric|api_key_alias=prod,api_provider=anthropic,hashed_api_key=abc123,model=claude-3,model_id=cm-42,team=eng,user=bob",
		},
		{
			// T2: a requests Row carrying model + route + status_code. The three
			// requests-family labels are emitted in sorted label-name order
			// (model < route < status_code).
			name: "requests route + status_code sorted",
			row: Row{
				Family:     "requests",
				MetricName: "litellm_proxy_total_requests_metric_total",
				Model:      "orchestration",
				Route:      "/v1/chat/completions",
				StatusCode: "200",
			},
			want: "requests|litellm_proxy_total_requests_metric_total|model=orchestration,route=/v1/chat/completions,status_code=200",
		},
		{
			// FIX (client_ip collision): when a Row carries the full parsed
			// label set, the key uses it verbatim — including labels that are
			// dropped from storage (client_ip). Two client IPs hitting the
			// same deployment must never share one delta-tracker key again.
			name: "SeriesLabels takes precedence and keeps dropped labels",
			row: Row{
				Family:       "requests",
				MetricName:   "litellm_requests_metric_total",
				Model:        "tools",
				ModelID:      "dep-glm",
				SeriesLabels: "api_key_alias=key-a,api_provider=openai,client_ip=192.0.2.251,model_id=dep-glm,requested_model=tools,user=default_user_id",
			},
			want: "requests|litellm_requests_metric_total|api_key_alias=key-a,api_provider=openai,client_ip=192.0.2.251,model_id=dep-glm,requested_model=tools,user=default_user_id",
		},
	}
	for _, c := range cases {
		got := c.row.SeriesKey()
		if got != c.want {
			t.Errorf("%s: SeriesKey() = %q, want %q", c.name, got, c.want)
		}
	}
}

// TestSeriesLabelsKeepDroppedLabelsDistinct verifies that two parser-built Rows
// whose source series differ ONLY in a storage-dropped label (client_ip) get
// distinct delta-tracker keys. This is the regression for the measured RPM
// inflation: two client IPs used to alternate one key, producing garbage
// deltas an order of magnitude above the true request rate.
func TestSeriesLabelsKeepDroppedLabelsDistinct(t *testing.T) {
	a := Row{
		Family:       "requests",
		MetricName:   "litellm_requests_metric_total",
		Model:        "tools",
		ModelID:      "dep-glm",
		SeriesLabels: "api_key_alias=key-a,client_ip=192.0.2.251,model_id=dep-glm",
	}
	b := Row{
		Family:       "requests",
		MetricName:   "litellm_requests_metric_total",
		Model:        "tools",
		ModelID:      "dep-glm",
		SeriesLabels: "api_key_alias=key-a,client_ip=192.0.2.253,model_id=dep-glm",
	}
	if a.SeriesKey() == b.SeriesKey() {
		t.Error("SeriesKey(): two client_ip series collide; dropped labels must stay in the key")
	}
}

// parseSampleFile parses the testdata/metrics_sample.prom fixture.
func parseSampleFile(t *testing.T) *Result {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "metrics_sample.prom"))
	if err != nil {
		t.Fatalf("read testdata: %v", err)
	}
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	res, err := Parse(string(data), ts, NewTripwire(10))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return res
}

// TestParseSampleFile verifies the end-to-end parse of the real-format fixture:
// SeriesCount=27, 14 stored rows, per-family counts.
func TestParseSampleFile(t *testing.T) {
	res := parseSampleFile(t)

	if res.SeriesCount != 27 {
		t.Errorf("SeriesCount = %d, want 27", res.SeriesCount)
	}
	if res.TripwireTripped {
		t.Error("TripwireTripped = true, want false")
	}
	if len(res.Rows) != 14 {
		t.Fatalf("len(Rows) = %d, want 14", len(res.Rows))
	}

	counts := map[string]int{}
	for _, r := range res.Rows {
		counts[r.Family]++
	}
	want := map[string]int{"input_tokens": 1, "output_tokens": 1, "total_tokens": 1, "requests": 2,
		"spend": 1, "latency": 4, "limits": 1, "deployment_health": 2, "counters": 1}
	for fam, n := range want {
		if counts[fam] != n {
			t.Errorf("family %q: %d rows, want %d", fam, counts[fam], n)
		}
	}

	// Verify specific SeriesKeys.
	keys := make([]string, 0, len(res.Rows))
	for _, r := range res.Rows {
		keys = append(keys, r.SeriesKey())
	}
	sort.Strings(keys)

	expectedKeys := []string{
		"latency|litellm_deployment_latency_per_output_token_count|api_base=http://192.0.2.252:8731/v1,api_key_alias=None,api_provider=openai,hashed_api_key=litellm_proxy_master_key,litellm_model_name=halogen-qwen3.8-flash-next,model_id=orchestration-qwen38,team=None",
		"latency|litellm_deployment_latency_per_output_token_sum|api_base=http://192.0.2.252:8731/v1,api_key_alias=None,api_provider=openai,hashed_api_key=litellm_proxy_master_key,litellm_model_name=halogen-qwen3.8-flash-next,model_id=orchestration-qwen38,team=None",
		"latency|litellm_request_total_latency_metric_count|api_key_alias=None,api_provider=openai,end_user=None,hashed_api_key=litellm_proxy_master_key,model=halogen-qwen3.8-flash-next,model_id=orchestration-qwen38,requested_model=orchestration,team=None,user=default_user_id",
		"latency|litellm_request_total_latency_metric_sum|api_key_alias=None,api_provider=openai,end_user=None,hashed_api_key=litellm_proxy_master_key,model=halogen-qwen3.8-flash-next,model_id=orchestration-qwen38,requested_model=orchestration,team=None,user=default_user_id",
		"limits|litellm_remaining_tokens_metric|api_base=http://192.0.2.252:8731/v1,api_key_alias=None,api_provider=openai,hashed_api_key=litellm_proxy_master_key,litellm_model_name=halogen-qwen3.8-flash-next,model_group=orchestration,model_id=orchestration-qwen38",
		"deployment_health|litellm_deployment_state|api_base=http://192.0.2.252:8731/v1,api_provider=openai,litellm_model_name=halogen-qwen3.8-flash-next,model_id=orchestration-qwen38",
		"deployment_health|litellm_deployment_state|api_base=http://192.0.2.252:8731/v1,api_provider=openai,litellm_model_name=orchestration,model_id=orchestration-qwen38",
		"counters|litellm_deployment_cooled_down_total|api_base=http://192.0.2.252:8731/v1,api_provider=openai,exception_status=429,litellm_model_name=halogen-qwen3.8-flash-next,model_id=orchestration-qwen38",
		"requests|litellm_requests_metric_total|api_key_alias=None,api_provider=anthropic,client_ip=192.0.2.21,end_user=None,hashed_api_key=other_key_hash,model=other-model,model_id=other-model-42,org_alias=None,org_id=None,requested_model=other-model,team=t1,team_alias=None,user=bob,user_agent=curl/8.5.0,user_email=None",
		"requests|litellm_requests_metric_total|api_key_alias=None,api_provider=openai,client_ip=192.0.2.20,end_user=None,hashed_api_key=litellm_proxy_master_key,model=halogen-qwen3.8-flash-next,model_id=orchestration-qwen38,org_alias=None,org_id=None,requested_model=orchestration,team=None,team_alias=None,user=default_user_id,user_agent=example-client/1.0,user_email=None",
		"spend|litellm_spend_metric_total|api_key_alias=None,api_provider=openai,client_ip=192.0.2.20,end_user=None,hashed_api_key=litellm_proxy_master_key,model=halogen-qwen3.8-flash-next,model_id=orchestration-qwen38,requested_model=orchestration,team=None,user=default_user_id,user_agent=example-client/1.0,user_email=None",
		"input_tokens|litellm_input_tokens_metric_total|api_key_alias=None,api_provider=openai,end_user=None,hashed_api_key=litellm_proxy_master_key,model=halogen-qwen3.8-flash-next,model_id=orchestration-qwen38,requested_model=orchestration,team=None,user=default_user_id",
		"output_tokens|litellm_output_tokens_metric_total|api_key_alias=None,api_provider=openai,end_user=None,hashed_api_key=litellm_proxy_master_key,model=halogen-qwen3.8-flash-next,model_id=orchestration-qwen38,requested_model=orchestration,team=None,user=default_user_id",
		"total_tokens|litellm_total_tokens_metric_total|api_key_alias=None,api_provider=openai,end_user=None,hashed_api_key=litellm_proxy_master_key,model=halogen-qwen3.8-flash-next,model_id=orchestration-qwen38,requested_model=orchestration,team=None,user=default_user_id",
	}
	sort.Strings(expectedKeys)
	if len(keys) != len(expectedKeys) {
		t.Fatalf("got %d keys, want %d", len(keys), len(expectedKeys))
	}
	for i := range expectedKeys {
		if keys[i] != expectedKeys[i] {
			t.Errorf("key[%d] = %q, want %q", i, keys[i], expectedKeys[i])
		}
	}

	// deployment_health rows: the litellm_deployment_state gauge value is
	// normalised to a status string, and the two deployments that share one
	// model_id stay two distinct series (composite key).
	statuses := map[string]string{}
	for _, r := range res.Rows {
		if r.Family == "deployment_health" {
			statuses[r.LitellmModelName] = r.Status
		}
	}
	if len(statuses) != 2 {
		t.Fatalf("deployment_health deployments = %d, want 2", len(statuses))
	}
	if statuses["halogen-qwen3.8-flash-next"] != "healthy" {
		t.Errorf("halogen-qwen3.8-flash-next status = %q, want \"healthy\" (gauge 0.0)", statuses["halogen-qwen3.8-flash-next"])
	}
	if statuses["orchestration"] != "error" {
		t.Errorf("orchestration status = %q, want \"error\" (gauge 2.0)", statuses["orchestration"])
	}
}

// TestHistogramRows verifies histogram metrics produce _sum and _count rows
// with correct MetricName, Unit, and IsCounter.
func TestHistogramRows(t *testing.T) {
	res := parseSampleFile(t)

	var sumRows, countRows []Row
	for _, r := range res.Rows {
		if r.Family != "latency" {
			continue
		}
		if strings.HasSuffix(r.MetricName, "_sum") {
			sumRows = append(sumRows, r)
		} else if strings.HasSuffix(r.MetricName, "_count") {
			countRows = append(countRows, r)
		}
	}

	if len(sumRows) != 2 {
		t.Errorf("sum rows: %d, want 2", len(sumRows))
	}
	if len(countRows) != 2 {
		t.Errorf("count rows: %d, want 2", len(countRows))
	}
	for _, r := range sumRows {
		if !r.IsCounter {
			t.Errorf("sum row %q: IsCounter=false, want true", r.MetricName)
		}
		if r.Unit != "s_sum" {
			t.Errorf("sum row %q: Unit=%q, want s_sum", r.MetricName, r.Unit)
		}
	}
	for _, r := range countRows {
		if !r.IsCounter {
			t.Errorf("count row %q: IsCounter=false, want true", r.MetricName)
		}
		if r.Unit != "count" {
			t.Errorf("count row %q: Unit=%q, want count", r.MetricName, r.Unit)
		}
	}
}

// TestIsCounter verifies IsCounter is true for counters and histogram sum/count,
// false for gauges.
func TestIsCounter(t *testing.T) {
	res := parseSampleFile(t)

	for _, r := range res.Rows {
		isToken := r.Family == "input_tokens" || r.Family == "output_tokens" || r.Family == "reasoning_tokens" ||
			r.Family == "cached_tokens" || r.Family == "total_tokens"
		wantCounter := r.Family == "requests" || r.Family == "spend" || isToken ||
			r.Family == "counters" ||
			strings.HasSuffix(r.MetricName, "_sum") || strings.HasSuffix(r.MetricName, "_count")
		if r.IsCounter != wantCounter {
			t.Errorf("Row{MetricName=%q, Family=%q}: IsCounter=%v, want %v",
				r.MetricName, r.Family, r.IsCounter, wantCounter)
		}
	}
}

// TestDroppedLabels verifies dropped label values never appear in any Row field.
func TestDroppedLabels(t *testing.T) {
	res := parseSampleFile(t)

	droppedValues := []string{
		"192.0.2.20",
		"192.0.2.21",
		"example-client/1.0",
		"curl/8.5.0",
	}
	for _, v := range droppedValues {
		for _, r := range res.Rows {
			fields := []string{r.Model, r.ModelID, r.APIProvider,
				r.HashedAPIKey, r.APIKeyAlias, r.User, r.Team, r.Unit, r.Family, r.MetricName,
				r.LitellmModelName, r.ExceptionStatus, r.Status}
			for _, f := range fields {
				if f == v {
					t.Errorf("dropped label value %q leaked into Row field", v)
				}
			}
		}
	}
}

// TestAPiBaseStripped verifies api_base is never stored in any Row.
func TestAPiBaseStripped(t *testing.T) {
	res := parseSampleFile(t)

	apiBaseValue := "http://192.0.2.252:8731/v1"
	for _, r := range res.Rows {
		fields := []string{r.Model, r.ModelID, r.APIProvider,
			r.HashedAPIKey, r.APIKeyAlias, r.User, r.Team, r.Unit, r.Family, r.MetricName,
			r.LitellmModelName, r.ExceptionStatus, r.Status}
		for _, f := range fields {
			if f == apiBaseValue {
				t.Errorf("api_base value leaked into Row field in family %q", r.Family)
			}
		}
	}
}

// TestDeploymentStateCompositeKey verifies that litellm_deployment_state rows
// for the SAME model_id but DIFFERENT litellm_model_name are two distinct
// series — the composite identity the dashboard's
// `DISTINCT ON (model_id, litellm_model_name)` query depends on — and that
// the gauge value is normalised to a closed status vocabulary.
func TestDeploymentStateCompositeKey(t *testing.T) {
	a := Row{
		Family:           "deployment_health",
		MetricName:       "litellm_deployment_state",
		ModelID:          "orchestration-qwen38",
		LitellmModelName: "halogen-qwen3.8-flash-next",
		Status:           valueToStatus(0),
	}
	b := Row{
		Family:           "deployment_health",
		MetricName:       "litellm_deployment_state",
		ModelID:          "orchestration-qwen38",
		LitellmModelName: "orchestration",
		Status:           valueToStatus(2),
	}

	if a.SeriesKey() == b.SeriesKey() {
		t.Fatalf("composite key collision: both = %q", a.SeriesKey())
	}

	// Hand-built rows carry ONLY the composite identity labels, so the key is
	// exactly the composite (litellm_model_name, model_id) with no other part.
	wantA := "deployment_health|litellm_deployment_state|litellm_model_name=halogen-qwen3.8-flash-next,model_id=orchestration-qwen38"
	if a.SeriesKey() != wantA {
		t.Errorf("SeriesKey() = %q, want %q", a.SeriesKey(), wantA)
	}

	// Status is the VALUE, not an identity label: it must never appear as a
	// label in the series key.
	if strings.Contains(a.SeriesKey(), "status=") {
		t.Errorf("SeriesKey() must not carry a status label: %q", a.SeriesKey())
	}

	// Caller decision: 0 -> healthy; every non-zero -> error.
	if got := valueToStatus(0); got != "healthy" {
		t.Errorf("valueToStatus(0) = %q, want \"healthy\"", got)
	}
	if got := valueToStatus(1); got != "error" {
		t.Errorf("valueToStatus(1) = %q, want \"error\"", got)
	}
	if got := valueToStatus(2); got != "error" {
		t.Errorf("valueToStatus(2) = %q, want \"error\"", got)
	}
}

// TestCooledDownCounters verifies litellm_deployment_cooled_down_total lands in
// the generic `counters` family, carries exception_status as its differentiating
// label, and is NOT treated as traffic-light state (no status derived, and
// litellm_model_name is deliberately not read for this family).
func TestCooledDownCounters(t *testing.T) {
	res := parseSampleFile(t)

	var rows []Row
	for _, r := range res.Rows {
		if r.MetricName == "litellm_deployment_cooled_down_total" {
			rows = append(rows, r)
		}
	}
	if len(rows) != 1 {
		t.Fatalf("cooled_down_total rows = %d, want 1", len(rows))
	}

	r := rows[0]
	if r.Family != "counters" {
		t.Errorf("Family = %q, want \"counters\"", r.Family)
	}
	if r.ExceptionStatus != "429" {
		t.Errorf("ExceptionStatus = %q, want \"429\" (from the exception_status label)", r.ExceptionStatus)
	}
	if !strings.Contains(r.SeriesKey(), "exception_status=429") {
		t.Errorf("SeriesKey() missing exception_status: %q", r.SeriesKey())
	}
	// FIX (client_ip collision): parser Rows now key on the FULL label set, so
	// labels that are dropped from storage (api_base, litellm_model_name) still
	// appear in the key.
	want := "counters|litellm_deployment_cooled_down_total|api_base=http://192.0.2.252:8731/v1,api_provider=openai,exception_status=429,litellm_model_name=halogen-qwen3.8-flash-next,model_id=orchestration-qwen38"
	if r.SeriesKey() != want {
		t.Errorf("SeriesKey() = %q, want %q", r.SeriesKey(), want)
	}
	if !r.IsCounter {
		t.Error("IsCounter = false, want true for a _total counter")
	}
	// Not health state: no status is derived for the counters family, and the
	// deployment-side litellm_model_name label is not read for it either.
	if r.Status != "" {
		t.Errorf("Status = %q, want empty for the counters family", r.Status)
	}
	if r.LitellmModelName != "" {
		t.Errorf("LitellmModelName = %q, want empty for the counters family", r.LitellmModelName)
	}
}

// TestSeriesKeyCollisionResolution (T1) verifies that sibling requests-family
// series that are identical in Family/MetricName/Model/APIProvider but differ
// ONLY by status_code, route, or exception_class now produce DISTINCT series
// keys — the collision the delta tracker previously suffered.
func TestSeriesKeyCollisionResolution(t *testing.T) {
	base := Row{
		Family:      "requests",
		MetricName:  "litellm_proxy_total_requests_metric_total",
		Model:       "orchestration",
		APIProvider: "openai",
	}
	withStatus := base
	withStatus.StatusCode = "200"
	withStatus576 := base
	withStatus576.StatusCode = "576"
	withRoute := base
	withRoute.Route = "/v1/chat/completions"
	withExcClass := base
	withExcClass.ExceptionClass = "APIConnectionError"

	seen := map[string]string{}
	for name, r := range map[string]Row{
		"base":          base,
		"status_200":    withStatus,
		"status_576":    withStatus576,
		"route":         withRoute,
		"exception_cls": withExcClass,
	} {
		key := r.SeriesKey()
		if prev, dup := seen[key]; dup {
			t.Errorf("series key collision: %q and %q both produce %q", prev, name, key)
		}
		seen[key] = name
	}
	// base (no differentiator) must differ from each of the four variants, and
	// the four variants must differ from one another → 5 distinct keys.
	if len(seen) != 5 {
		t.Errorf("distinct series keys = %d, want 5 (base + status200 + status576 + route + exception_class)", len(seen))
	}
}

// TestRequestsEmptyModelSkipped (T3) verifies the proxy's own /metrics
// self-traffic — a requests-family series whose effective Model is empty
// (requested_model="") — is dropped, while a healthy requests series with a
// non-empty requested_model survives.
func TestRequestsEmptyModelSkipped(t *testing.T) {
	input := `
# HELP litellm_proxy_total_requests_metric_total Total requests
# TYPE litellm_proxy_total_requests_metric_total counter
litellm_requests_metric_total{route="/metrics",requested_model="",status_code="200",user="None"} 1
litellm_requests_metric_total{route="/v1/chat/completions",requested_model="orchestration",status_code="200",user="alice"} 5
`
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	res, err := Parse(input, ts, NewTripwire(10))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(res.Rows) != 1 {
		t.Fatalf("len(Rows) = %d, want 1 (empty-model self-traffic dropped)", len(res.Rows))
	}
	r := res.Rows[0]
	if r.Model != "orchestration" {
		t.Errorf("surviving row Model = %q, want \"orchestration\"", r.Model)
	}
	if r.Route != "/v1/chat/completions" {
		t.Errorf("surviving row Route = %q, want \"/v1/chat/completions\"", r.Route)
	}
	for _, row := range res.Rows {
		if row.Model == "" {
			t.Errorf("empty-model requests row was NOT skipped: %+v", row)
		}
	}
}

// TestOtherFamiliesEmptyModelKept (T4) verifies the empty-model skip is scoped
// to the requests family ONLY: a non-requests row with an empty Model is still
// kept, and a non-requests Row's SeriesKey carries none of the new
// route/status_code/exception_class segments.
func TestOtherFamiliesEmptyModelKept(t *testing.T) {
	input := `
# HELP litellm_input_tokens_metric_total Input tokens
# TYPE litellm_input_tokens_metric_total counter
litellm_input_tokens_metric_total{api_provider="openai",requested_model="",model=""} 7
`
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	res, err := Parse(input, ts, NewTripwire(10))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(res.Rows) != 1 {
		t.Fatalf("len(Rows) = %d, want 1 (empty-model non-requests row must be kept)", len(res.Rows))
	}
	r := res.Rows[0]
	if r.Family != "input_tokens" {
		t.Errorf("Family = %q, want input_tokens", r.Family)
	}
	if r.Model != "" {
		t.Errorf("Model = %q, want empty (and still kept)", r.Model)
	}
	key := r.SeriesKey()
	if key != "input_tokens|litellm_input_tokens_metric_total|api_provider=openai,model=,requested_model=" {
		t.Errorf("SeriesKey() = %q, want %q", key, "input_tokens|litellm_input_tokens_metric_total|api_provider=openai,model=,requested_model=")
	}
	for _, seg := range []string{"route=", "status_code=", "exception_class="} {
		if strings.Contains(key, seg) {
			t.Errorf("non-requests SeriesKey %q must not contain %q", key, seg)
		}
	}
}

// TestRequestsRowFieldsPopulated verifies buildRow populates StatusCode, Route
// and ExceptionClass for the requests family from the authoritative label
// names, and leaves them empty for other families.
func TestRequestsRowFieldsPopulated(t *testing.T) {
	input := `
# HELP litellm_proxy_failed_requests_metric_total Failed requests
# TYPE litellm_proxy_failed_requests_metric_total counter
litellm_requests_metric_total{requested_model="orchestration",route="/v1/chat/completions",status_code="576",exception_class="APIConnectionError",exception_status="500"} 1
`
	ts := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	res, err := Parse(input, ts, NewTripwire(10))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(res.Rows) != 1 {
		t.Fatalf("len(Rows) = %d, want 1", len(res.Rows))
	}
	r := res.Rows[0]
	if r.StatusCode != "576" {
		t.Errorf("StatusCode = %q, want \"576\"", r.StatusCode)
	}
	if r.Route != "/v1/chat/completions" {
		t.Errorf("Route = %q, want \"/v1/chat/completions\"", r.Route)
	}
	if r.ExceptionClass != "APIConnectionError" {
		t.Errorf("ExceptionClass = %q, want \"APIConnectionError\"", r.ExceptionClass)
	}
	// exception_status is read ONLY for the counters family (family-scoped),
	// so it stays empty here even though the label is present on the series.
	if r.ExceptionStatus != "" {
		t.Errorf("ExceptionStatus = %q, want empty for the requests family (counters-only label)", r.ExceptionStatus)
	}
}
