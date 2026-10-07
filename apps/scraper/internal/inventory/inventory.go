// Package inventory fetches a LiteLLM proxy's /model/info catalog, parses the
// deployment records, persists them, and keeps a last-known-good
// model_id -> model_group cache that the parser uses to map physical model ids
// back to logical model groups.
//
// The cache implements a last-known-good invariant: it is replaced ONLY after a
// full fetch -> parse -> upsert success, so a failed /model/info call never
// discards previously known inventory. The persistence path is upsert-only and
// never deletes rows or nulls last_alive.
package inventory

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
)

// Deployment is one record from the LiteLLM /model/info catalog.
//
// ModelID is the physical deployment id (model_info.id) and is the unique key
// of the inventory. ModelGroup is the logical model group (the top-level
// "model_name") and must never be empty: the deployment_inventory.model_group
// column is NOT NULL, so entries without a resolvable group are dropped at
// parse time. APIBase and RawModel come from litellm_params and may
// legitimately be empty; the store upsert COALESCEs them so a later empty
// report never overwrites a previously stored non-empty value.
type Deployment struct {
	ModelID    string
	ModelGroup string
	APIBase    string
	RawModel   string
}

// NoneModelID is the literal string LiteLLM emits for the model_id of series
// that map to no deployment (cache / unmapped traffic). It is a sentinel, not a
// deployment, and must never become an inventory row.
const NoneModelID = "None"

// Lookup resolves a physical model_id back to its logical model group. ok is
// false when the id is empty or unknown. The parser uses this to map a
// physical model_id onto a logical grouping bucket.
type Lookup func(modelID string) (string, bool)

// Upserter persists a parsed deployment catalog. The store implements this
// with a single multi-row upsert keyed on model_id.
type Upserter interface {
	UpsertDeployments(ctx context.Context, deps []Deployment) error
}

// ModelInfoURL derives the /model/info URL from a scrape (metrics) URL by
// replacing its path with /model/info while keeping scheme, host and port.
//
// Example: http://h:4001/metrics/ -> http://h:4001/model/info.
//
// RawPath, Opaque, Fragment and RawQuery are cleared so the returned URL is a
// clean, canonical /model/info address with no leftover query or fragment.
func ModelInfoURL(scrapeURL string) (string, error) {
	u, err := url.Parse(scrapeURL)
	if err != nil {
		return "", fmt.Errorf("model info url: %w", err)
	}
	if u.Host == "" {
		return "", fmt.Errorf("model info url: missing host in %q", scrapeURL)
	}
	u.Path = "/model/info"
	u.RawPath = ""
	u.Opaque = ""
	u.Fragment = ""
	u.RawQuery = ""
	u.ForceQuery = false
	return u.String(), nil
}

// modelInfoResponse is the tolerant decoder for the LiteLLM /model/info JSON.
// Every field is a plain (pointer-free) string so that unknown or extra fields
// in the payload are ignored, and a missing or partially populated field simply
// yields "".
type modelInfoResponse struct {
	Data []struct {
		ModelName string `json:"model_name"`
		// Pointer so an entry that omits litellm_params entirely is detectable
		// and skippable. Extra fields inside it (e.g. "tpm") are ignored.
		LitellmParams *struct {
			Model   string `json:"model"`
			APIBase string `json:"api_base"`
		} `json:"litellm_params"`
		// Pointer for the same reason: an entry with no model_info has no join
		// key and is not a deployment.
		ModelInfo *struct {
			ID string `json:"id"`
		} `json:"model_info"`
	} `json:"data"`
}

// ParseModelInfo decodes a LiteLLM /model/info JSON payload into a deduplicated
// slice of Deployment records.
//
// For each entry: ModelID = model_info.id (TrimSpace); the entry is skipped if
// ModelID is empty. ModelGroup = model_name (TrimSpace); the entry is also
// skipped if ModelGroup is empty, because deployment_inventory.model_group is
// NOT NULL. APIBase = litellm_params.api_base; RawModel = litellm_params.model.
//
// Entries are deduplicated by ModelID with the LAST occurrence winning, while
// preserving the first-seen order of the surviving ids. A missing "data" key
// yields an empty slice and a nil error. Malformed JSON is an error.
func ParseModelInfo(body []byte) ([]Deployment, error) {
	var resp modelInfoResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("parse model info: %w", err)
	}

	order := make([]string, 0, len(resp.Data))
	byID := make(map[string]Deployment, len(resp.Data))
	for _, e := range resp.Data {
		if e.ModelInfo == nil || e.LitellmParams == nil {
			// Missing model_info means no join key; missing litellm_params means
			// the entry is malformed. Skip it and keep parsing the rest - never
			// abort the whole payload.
			continue
		}
		modelID := strings.TrimSpace(e.ModelInfo.ID)
		if modelID == "" || modelID == NoneModelID {
			// "" has no join key; the literal "None" is LiteLLM's sentinel for
			// cache / no-mapped-deployment series and is NOT a deployment.
			continue
		}
		modelGroup := strings.TrimSpace(e.ModelName)
		if modelGroup == "" {
			continue
		}
		if _, exists := byID[modelID]; !exists {
			order = append(order, modelID)
		}
		// Last occurrence wins: overwriting byID each time an id recurs, while
		// order keeps only the first-seen position of each surviving id.
		byID[modelID] = Deployment{
			ModelID:    modelID,
			ModelGroup: modelGroup,
			APIBase:    e.LitellmParams.APIBase,
			RawModel:   e.LitellmParams.Model,
		}
	}

	deps := make([]Deployment, 0, len(order))
	for _, id := range order {
		deps = append(deps, byID[id])
	}
	return deps, nil
}

// Cache is a last-known-good model_id -> model_group map safe for concurrent
// use. It is replaced wholesale (never mutated in place) so a reader never
// observes a partially-updated map, and the map is swapped only after a fully
// successful sync — preserving the last-known-good invariant.
type Cache struct {
	mu     sync.RWMutex
	groups map[string]string
}

// NewCache returns an empty inventory cache.
func NewCache() *Cache {
	return &Cache{groups: make(map[string]string)}
}

// Replace atomically swaps the cache's map with a fresh one built from deps
// (model_id -> model_group). A nil or empty deps slice results in an empty map.
func (c *Cache) Replace(deps []Deployment) {
	next := make(map[string]string, len(deps))
	for _, d := range deps {
		// Defence in depth against the "None" sentinel reaching the cache.
		if d.ModelID == "" || d.ModelID == NoneModelID {
			continue
		}
		next[d.ModelID] = d.ModelGroup
	}
	c.mu.Lock()
	c.groups = next
	c.mu.Unlock()
}

// Resolve returns the logical model group for modelID. ok is false when
// modelID is empty or absent from the cache.
func (c *Cache) Resolve(modelID string) (string, bool) {
	if modelID == "" {
		return "", false
	}
	c.mu.RLock()
	g, ok := c.groups[modelID]
	c.mu.RUnlock()
	return g, ok
}

// Fetcher fetches the raw body of a scrape endpoint. It is satisfied by the
// existing *fetcher.Fetcher; no http.Client is created here.
type Fetcher interface {
	Scrape(ctx context.Context, url, apiKey string) ([]byte, error)
}

// Syncer pulls a /model/info catalog for one target, persists the deployments,
// and updates the shared last-known-good cache — in that order, and only the
// cache update happens after everything else has succeeded.
type Syncer struct {
	fetch Fetcher
	up    Upserter
	cache *Cache
	log   *log.Logger
}

// NewSyncer wires a Syncer. If l is nil, log.Default() is used.
func NewSyncer(f Fetcher, u Upserter, c *Cache, l *log.Logger) *Syncer {
	if l == nil {
		l = log.Default()
	}
	return &Syncer{fetch: f, up: u, cache: c, log: l}
}

// LAST-KNOWN-GOOD INVARIANT (central to this method):
//
//	On ANY error path the cache is NOT replaced and NO DB row is written, so
//	previously stored inventory rows and their last_alive values survive a
//	failed /model/info call. Steps 1-4 run strictly before the cache is
//	refreshed (step 5), and each returns an error immediately on failure — so a
//	fetch failure, a decode failure, or an upsert failure leaves the cache and
//	the database completely untouched. The persistence step is an upsert only:
//	nothing here ever deletes a row or nulls last_alive.
func (s *Syncer) Sync(ctx context.Context, name, scrapeURL, apiKey string) (int, error) {
	// 1. Derive the /model/info URL from the scrape URL.
	u, err := ModelInfoURL(scrapeURL)
	if err != nil {
		return 0, err
	}

	// 2. Fetch the catalog.
	body, err := s.fetch.Scrape(ctx, u, apiKey)
	if err != nil {
		return 0, fmt.Errorf("model info fetch %s: %w", name, err)
	}

	// 3. Decode the catalog into deployments.
	deps, err := ParseModelInfo(body)
	if err != nil {
		return 0, fmt.Errorf("model info decode %s: %w", name, err)
	}

	// 4. Persist the deployments (upsert only; never deletes, never nulls
	// last_alive). On any error here the cache is left untouched too.
	if err := s.up.UpsertDeployments(ctx, deps); err != nil {
		return 0, fmt.Errorf("model info upsert %s: %w", name, err)
	}

	// 5. ONLY after all of the above succeeded, refresh the last-known-good
	// cache. This ordering is what guarantees a failed call cannot discard
	// previously known inventory.
	s.cache.Replace(deps)
	s.log.Printf("inventory: synced %d deployment(s) for %q", len(deps), name)
	return len(deps), nil
}
