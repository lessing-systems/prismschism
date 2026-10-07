// Package fetcher performs authenticated HTTP GET requests against scrape
// targets and returns the raw response body.
package fetcher

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"
)

// DefaultTimeout is the per-request timeout applied when no explicit timeout
// is configured for a target.
const DefaultTimeout = 5 * time.Second

// Fetcher issues authenticated GET requests to scrape endpoints.
type Fetcher struct {
	client *http.Client
}

// New creates a Fetcher whose HTTP client aborts any request taking longer
// than timeout (connect, TLS, redirects, and body reads included).
//
// Redirect behavior (verified behavior of net/http): Go's http.Client follows
// up to 10 redirects by default, and for same-host 307/308 responses (e.g.
// /metrics -> /metrics/) it re-applies the original request headers to the
// redirected request, so the Authorization header is preserved across the
// redirect. Targets that 307-redirect their base path rely on this.
func New(timeout time.Duration) *Fetcher {
	return &Fetcher{client: &http.Client{Timeout: timeout}}
}

// Scrape performs an authenticated GET against url and returns the full
// response body.
//
// Error strings never contain apiKey: non-2xx responses are reported as
// "fetch <url>: status <code>" (status code and URL only), and transport
// errors are wrapped with the URL only.
func (f *Fetcher) Scrape(ctx context.Context, url, apiKey string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", url, err)
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := f.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", url, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: reading body: %w", url, err)
	}

	if resp.StatusCode != http.StatusOK {
		// Deliberately include only the status code and the URL — never apiKey.
		return nil, fmt.Errorf("fetch %s: status %d", url, resp.StatusCode)
	}
	return body, nil
}
