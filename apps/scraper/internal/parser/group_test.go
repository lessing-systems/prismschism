package parser

import (
	"testing"

	dto "github.com/prometheus/client_model/go"
)

func lp(name, value string) *dto.LabelPair {
	n, v := name, value
	return &dto.LabelPair{Name: &n, Value: &v}
}

func lps(pairs ...*dto.LabelPair) []*dto.LabelPair { return pairs }

// installLookup swaps the package-level inventory lookup for the duration of one
// test and restores whatever was installed before it.
func installLookup(t *testing.T, fn func(string) (string, bool)) {
	t.Helper()
	prev := groupLookup.Load()
	t.Cleanup(func() {
		if prev != nil {
			groupLookup.Store(prev)
			return
		}
		SetGroupLookup(func(string) (string, bool) { return "", false })
	})
	SetGroupLookup(fn)
}

func TestResolveGroupDecisionTable(t *testing.T) {
	inv := map[string]string{"mid-tools": "tools", "mid-orch": "orchestration"}
	installLookup(t, func(id string) (string, bool) {
		g, ok := inv[id]
		return g, ok
	})

	cases := []struct {
		name   string
		family string
		labels []*dto.LabelPair
		want   string
	}{
		{"requested_model wins on a deployment-scoped family", FamilyCachedTokens,
			lps(lp("requested_model", "tools"), lp("model", "Qwen3.8-27B-Q3_K_M.gguf"), lp("model_id", "mid-tools")), "tools"},
		{"requested_model wins even when model_id maps elsewhere", FamilyRequests,
			lps(lp("requested_model", "vision-tools"), lp("model", "raw-phys"), lp("model_id", "mid-tools")), "vision-tools"},
		{"requested_model that IS a deployment name resolves via the inventory, not as a group", FamilyRequests,
			lps(lp("requested_model", "mid-orch"), lp("model", "raw-phys"), lp("model_id", "mid-orch")), "orchestration"},
		{"requested_model naming an unrelated deployment still resolves via that deployment's group", FamilyRequests,
			lps(lp("requested_model", "mid-tools"), lp("model", "raw-phys"), lp("model_id", "mid-orch")), "orchestration"},
		{"requested_model wins on a non-deployment-scoped family", "latency",
			lps(lp("requested_model", "orchestration"), lp("model", "raw-phys")), "orchestration"},
		{"scoped family, no requested_model, model_id in inventory gives inventory group", FamilyCachedTokens,
			lps(lp("model", "Qwen3.8-27B-Q3_K_M.gguf"), lp("model_id", "mid-tools")), "tools"},
		{"requests family is deployment-scoped too", FamilyRequests,
			lps(lp("model", "halogen-qwen3.8-flash-next"), lp("model_id", "mid-orch")), "orchestration"},
		{"scoped family, model_id absent from inventory gives unassigned", FamilyInputTokens,
			lps(lp("model", "Qwen3.8-27B-Q3_K_M.gguf"), lp("model_id", "mid-ghost")), UnassignedGroup},
		{"scoped family, missing model_id label falls back to raw model", FamilyOutputTokens,
			lps(lp("model", "halogen-qwen3.8-flash-next")), "halogen-qwen3.8-flash-next"},
		{"scoped family, empty model_id falls back to raw model", FamilyTotalTokens,
			lps(lp("model", "halogen-qwen3.8-flash-next"), lp("model_id", "")), "halogen-qwen3.8-flash-next"},
		{"non-scoped family without requested_model keeps legacy raw model", "latency",
			lps(lp("model", "Qwen3.8-27B-Q3_K_M.gguf"), lp("model_id", "mid-tools")), "Qwen3.8-27B-Q3_K_M.gguf"},
		{"non-scoped spend family ignores the inventory entirely", "spend",
			lps(lp("model", "raw-phys"), lp("model_id", "mid-ghost")), "raw-phys"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveGroup(c.labels, c.family); got != c.want {
				t.Fatalf("resolveGroup() = %q, want %q", got, c.want)
			}
		})
	}
}

func TestResolveGroupNoneModelIDIsNeverLookedUp(t *testing.T) {
	var looked []string
	installLookup(t, func(id string) (string, bool) {
		looked = append(looked, id)
		if id == "mid-tools" {
			return "tools", true
		}
		return "", false
	})

	families := []string{
		FamilyInputTokens, FamilyOutputTokens, FamilyReasoningTokens,
		FamilyCachedTokens, FamilyTotalTokens, FamilyRequests,
	}
	for _, family := range families {
		t.Run(family, func(t *testing.T) {
			looked = nil
			got := resolveGroup(
				lps(lp("model", "halogen-qwen3.8-flash-next"), lp("model_id", "None")),
				family,
			)
			if got != "halogen-qwen3.8-flash-next" {
				t.Fatalf("resolveGroup(%s) = %q, want the raw model label", family, got)
			}
			if len(looked) != 0 {
				t.Fatalf("resolveGroup(%s) looked up the sentinel model_id: %v", family, looked)
			}
		})
	}
}

func TestResolveGroupEmptyModelIDIsNeverLookedUp(t *testing.T) {
	var looked []string
	installLookup(t, func(id string) (string, bool) {
		looked = append(looked, id)
		return "", false
	})

	resolveGroup(lps(lp("model", "raw-phys"), lp("model_id", "")), FamilyRequests)
	if len(looked) != 0 {
		t.Fatalf("empty model_id was looked up in the inventory: %v", looked)
	}
}

func TestIsDeploymentScopedTable(t *testing.T) {
	scoped := []string{
		FamilyInputTokens, FamilyOutputTokens, FamilyReasoningTokens,
		FamilyCachedTokens, FamilyTotalTokens, FamilyRequests,
	}
	notScoped := []string{"latency", "spend", "limits", "deployment_health", "counters", ""}

	for _, f := range scoped {
		if !isDeploymentScoped(f) {
			t.Errorf("isDeploymentScoped(%q) = false, want true", f)
		}
	}
	for _, f := range notScoped {
		if isDeploymentScoped(f) {
			t.Errorf("isDeploymentScoped(%q) = true, want false", f)
		}
	}
}

func TestUnassignedGroupConstant(t *testing.T) {
	if UnassignedGroup != "unassigned" {
		t.Fatalf("UnassignedGroup = %q, want %q", UnassignedGroup, "unassigned")
	}
}
