package inventory

import (
	"encoding/json"
	"strings"
	"testing"
)

func countGroups(deps []Deployment) map[string]int {
	out := map[string]int{}
	for _, d := range deps {
		out[d.ModelGroup]++
	}
	return out
}

func TestParseModelInfoRealShape(t *testing.T) {
	body := []byte(`{
  "data": [
    {"model_name":"tools","model_info":{"id":"11111111-1111-1111-1111-111111111111"},
     "litellm_params":{"model":"huggingface/Qwen3.8-27B-Q3_K_M.gguf","api_base":"http://a:8001/v1"}},
    {"model_name":"tools","model_info":{"id":"22222222-2222-2222-2222-222222222222"},
     "litellm_params":{"model":"huggingface/halogen-qwen3.8-flash-next","api_base":"http://b:8002/v1"}},
    {"model_name":"tools","model_info":{"id":"33333333-3333-3333-3333-333333333333"},
     "litellm_params":{"model":"openai/gpt-4o","api_base":"https://api.openai.com/v1"}},
    {"model_name":"orchestration","model_info":{"id":"44444444-4444-4444-4444-444444444444"},
     "litellm_params":{"model":"hosted_vllm/qwen3-27b","api_base":"http://c:8003/v1"}},
    {"model_name":"vision-tools","model_info":{"id":"55555555-5555-5555-5555-555555555555"},
     "litellm_params":{"model":"ollama/qwen3-vl","api_base":"http://d:11434"}}
  ]
}`)

	deps, err := ParseModelInfo(body)
	if err != nil {
		t.Fatalf("ParseModelInfo() error = %v", err)
	}
	if len(deps) != 5 {
		t.Fatalf("len(deps) = %d, want 5", len(deps))
	}

	want := map[string]int{"tools": 3, "orchestration": 1, "vision-tools": 1}
	got := countGroups(deps)
	for group, n := range want {
		if got[group] != n {
			t.Errorf("group %q count = %d, want %d (all: %v)", group, got[group], n, got)
		}
	}
	if len(got) != len(want) {
		t.Errorf("unexpected extra groups: %v", got)
	}

	byID := map[string]Deployment{}
	for _, d := range deps {
		byID[d.ModelID] = d
	}
	d := byID["11111111-1111-1111-1111-111111111111"]
	if d.ModelGroup != "tools" {
		t.Errorf("ModelGroup = %q, want tools", d.ModelGroup)
	}
	if d.APIBase != "http://a:8001/v1" {
		t.Errorf("APIBase = %q, want http://a:8001/v1", d.APIBase)
	}
	if d.RawModel != "huggingface/Qwen3.8-27B-Q3_K_M.gguf" {
		t.Errorf("RawModel = %q, want the raw physical model", d.RawModel)
	}
}

func TestParseModelInfoIgnoresUnknownExtraFields(t *testing.T) {
	body := []byte(`{"data":[{"model_name":"tools","model_info":{"id":"id-1","way_new":"x"},
     "litellm_params":{"model":"raw","api_base":"http://a","extra":true},"brand_new_field":1}],
     "top_level_extra":{"k":"v"}}`)

	deps, err := ParseModelInfo(body)
	if err != nil {
		t.Fatalf("ParseModelInfo() error = %v", err)
	}
	if len(deps) != 1 || deps[0].ModelID != "id-1" {
		t.Fatalf("unexpected result: %+v", deps)
	}
}

func TestParseModelInfoSkipsBadEntriesWithoutAborting(t *testing.T) {
	body := []byte(`{"data":[
     {"model_name":"no-params","model_info":{"id":"id-skip-1"}},
     {"model_name":"no-info","litellm_params":{"model":"raw","api_base":"http://a"}},
     {"model_name":"none-id","model_info":{"id":"None"},"litellm_params":{"model":"raw","api_base":"http://a"}},
     {"model_name":"blank-id","model_info":{"id":"   "},"litellm_params":{"model":"raw","api_base":"http://a"}},
     {"model_name":"   ","model_info":{"id":"id-blank-group"},"litellm_params":{"model":"raw","api_base":"http://a"}},
     {"model_name":"good","model_info":{"id":"id-good"},"litellm_params":{"model":"raw","api_base":"http://a"}}
   ]}`)

	deps, err := ParseModelInfo(body)
	if err != nil {
		t.Fatalf("ParseModelInfo() errored instead of skipping bad entries: %v", err)
	}
	if len(deps) != 1 {
		t.Fatalf("len(deps) = %d, want 1: %+v", len(deps), deps)
	}
	if deps[0].ModelID != "id-good" {
		t.Fatalf("kept the wrong entry: %+v", deps[0])
	}
	for _, d := range deps {
		if d.ModelID == "None" {
			t.Fatal("the None sentinel id became a row")
		}
	}
}

func TestParseModelInfoNoneIDNeverBecomesARow(t *testing.T) {
	body := []byte(`{"data":[{"model_name":"tools","model_info":{"id":"None"},
     "litellm_params":{"model":"raw","api_base":"http://a"}}]}`)

	deps, err := ParseModelInfo(body)
	if err != nil {
		t.Fatalf("ParseModelInfo() error = %v", err)
	}
	if len(deps) != 0 {
		t.Fatalf("len(deps) = %d, want 0: %+v", len(deps), deps)
	}
}

func TestParseModelInfoEmptyObject(t *testing.T) {
	deps, err := ParseModelInfo([]byte(`{}`))
	if err != nil {
		t.Fatalf("ParseModelInfo({}) error = %v, want nil error", err)
	}
	if deps == nil {
		t.Fatal("ParseModelInfo({}) returned nil, want an empty non-nil slice")
	}
	if len(deps) != 0 {
		t.Fatalf("len(deps) = %d, want 0", len(deps))
	}
}

func TestParseModelInfoBareArrayIsAnErrorNotAPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("ParseModelInfo panicked on a bare top-level array: %v", r)
		}
	}()

	deps, err := ParseModelInfo([]byte(`[{"model_name":"tools"}]`))
	if err == nil {
		t.Fatalf("bare top-level array accepted, want an error (got %+v)", deps)
	}
	if deps != nil {
		t.Fatalf("deps must be nil when parsing fails, got %+v", deps)
	}
	if !strings.Contains(err.Error(), "parse model info") {
		t.Errorf("error = %v, want it wrapped with %q", err, "parse model info")
	}
}

func TestParseModelInfoDedupesByModelIDLastWins(t *testing.T) {
	body := []byte(`{"data":[
     {"model_name":"tools","model_info":{"id":"dup"},"litellm_params":{"model":"raw-a","api_base":"http://a"}},
     {"model_name":"orchestration","model_info":{"id":"dup"},"litellm_params":{"model":"raw-b","api_base":"http://b"}}
   ]}`)

	deps, err := ParseModelInfo(body)
	if err != nil {
		t.Fatalf("ParseModelInfo() error = %v", err)
	}
	if len(deps) != 1 {
		t.Fatalf("len(deps) = %d, want 1 (deduped by model_id): %+v", len(deps), deps)
	}
	if deps[0].ModelGroup != "orchestration" {
		t.Errorf("ModelGroup = %q, want the last occurrence (orchestration)", deps[0].ModelGroup)
	}
}

func TestDeploymentJSONRoundTripIsNotRequired(t *testing.T) {
	b, err := json.Marshal(Deployment{ModelID: "x", ModelGroup: "g", APIBase: "b", RawModel: "r"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), "ModelID") {
		t.Skipf("Deployment is not intended to be serialised as JSON: %s", b)
	}
}
