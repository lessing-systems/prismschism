package parser

import (
	dto "github.com/prometheus/client_model/go"
)

// UnassignedGroup is the grouping bucket used when a deployment-scoped series
// has no resolvable logical group: its requested_model is absent and its
// model_id is either absent or not found in the inventory. The series is still
// emitted (its data is preserved); it is merely parked under this bucket
// rather than leaking a raw physical model name into front-end grouping.
const UnassignedGroup = "unassigned"

// noneModelID is LiteLLM's literal sentinel in the model_id label for cache /
// no-mapped-deployment series. It is not a real deployment id, so it must be
// treated exactly like an absent model_id: never looked up in the inventory,
// and never allowed to produce a bogus inventory hit.
const noneModelID = "None"

// isDeploymentScoped reports whether family is one of the LiteLLM families
// whose series must be grouped by deployment identity rather than by the raw
// physical "model" label: the five token counter families plus the "requests"
// family (fed by litellm_requests_metric_total and its sibling request
// counters). Series in these families can carry no requested_model label, which
// is what forces the model_id -> inventory-group fallback in resolveGroup.
func isDeploymentScoped(family string) bool {
	switch family {
	case FamilyInputTokens,
		FamilyOutputTokens,
		FamilyReasoningTokens,
		FamilyCachedTokens,
		FamilyTotalTokens,
		FamilyRequests:
		return true
	default:
		return false
	}
}

// resolveGroup computes the front-end grouping key for a series.
//
// WHY: physical model names (e.g. a GGUF filename such as
// "Qwen3.8-27B-Q3_K_M.gguf") must not leak into front-end grouping. Both the
// cached-token series
// (litellm_provider_cache_read_input_tokens_metric_total, family
// "cached_tokens") and the requests series (litellm_requests_metric_total and
// its sibling request counters) carry NO requested_model label, so falling
// back to the raw "model" label would surface the physical name. The data
// must be preserved, never dropped — so instead of discarding the series we
// map its model_id to a logical group via the inventory, and only park it
// under UnassignedGroup when no group can be resolved.
//
// Resolution order:
//
//  1. requested_model (when non-empty and NOT itself a known model_id) —
//     unchanged behaviour for series that carry it. When requested_model IS a
//     deployment's model_id (the client addressed the deployment directly),
//     it is a backend identity and resolution continues below.
//  2. Non-deployment-scoped families: the raw "model" label — unchanged.
//  3. Deployment-scoped family (token families or requests) without a usable
//     model_id (absent, or the literal "None" sentinel): the raw "model"
//     label — nothing to key on, so keep the old behaviour.
//  4. Deployment-scoped family with a model_id found in the inventory: the
//     logical group.
//  5. Deployment-scoped family with a model_id absent from the inventory:
//     UnassignedGroup (never the raw model; the series is still emitted).
func resolveGroup(labels []*dto.LabelPair, family string) string {
	if rm := labelValue(labels, "requested_model"); rm != "" && rm != noneModelID {
		// A client may address a deployment DIRECTLY: requested_model then
		// equals a deployment's model_id (measured on a real fleet:
		// requested_model="orchestration-glm53" alongside
		// model_id="orchestration-glm53"). A deployment name is a BACKEND
		// identity, not a front-end group — when requested_model IS a known
		// model_id, fall through to the model_id-based resolution below
		// instead of leaking a physical deployment name into front-end
		// grouping (it used to surface as a phantom front-end group).
		if _, isDeploymentName := modelGroupFor(rm); !isDeploymentName {
			return rm
		}
	}
	if !isDeploymentScoped(family) {
		return labelValue(labels, "model")
	}
	mid := labelValue(labels, "model_id")
	if mid == "" || mid == noneModelID {
		return labelValue(labels, "model")
	}
	if g, ok := modelGroupFor(mid); ok {
		return g
	}
	return UnassignedGroup
}
