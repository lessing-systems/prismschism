package fetcher

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestScrapeSendsBearerHeader(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte("OK\n"))
	}))
	defer srv.Close()

	f := New(DefaultTimeout)
	body, err := f.Scrape(context.Background(), srv.URL, "test-key-123")
	if err != nil {
		t.Fatalf("Scrape: %v", err)
	}
	if gotAuth != "Bearer test-key-123" {
		t.Errorf("Authorization header = %q, want %q", gotAuth, "Bearer test-key-123")
	}
	if string(body) != "OK\n" {
		t.Errorf("body = %q, want %q", body, "OK\n")
	}
}

func TestScrapeFollows307Redirect(t *testing.T) {
	var authAtTarget string
	mux := http.NewServeMux()
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/metrics/", http.StatusTemporaryRedirect)
	})
	mux.HandleFunc("/metrics/", func(w http.ResponseWriter, r *http.Request) {
		authAtTarget = r.Header.Get("Authorization")
		_, _ = w.Write([]byte("redirected-body\n"))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	f := New(DefaultTimeout)
	body, err := f.Scrape(context.Background(), srv.URL+"/metrics", "test-key-123")
	if err != nil {
		t.Fatalf("Scrape: %v", err)
	}
	if authAtTarget != "Bearer test-key-123" {
		t.Errorf("Authorization at redirect target = %q, want %q (header must survive same-host 307)",
			authAtTarget, "Bearer test-key-123")
	}
	if string(body) != "redirected-body\n" {
		t.Errorf("body = %q, want %q", body, "redirected-body\n")
	}
}

func TestScrapeNon200Error(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	f := New(DefaultTimeout)
	_, err := f.Scrape(context.Background(), srv.URL, "test-key-123")
	if err == nil {
		t.Fatal("Scrape: expected error for status 500, got nil")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("error %q does not mention status 500", err)
	}
	if !strings.Contains(err.Error(), srv.URL) {
		t.Errorf("error %q does not mention the URL", err)
	}
	if strings.Contains(err.Error(), "test-key-123") {
		t.Errorf("error %q leaks the api key", err)
	}
}

func TestScrapeTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		_, _ = w.Write([]byte("too-late\n"))
	}))
	defer srv.Close()

	f := New(50 * time.Millisecond)
	start := time.Now()
	_, err := f.Scrape(context.Background(), srv.URL, "test-key-123")
	if err == nil {
		t.Fatal("Scrape: expected timeout error, got nil")
	}
	if elapsed := time.Since(start); elapsed >= 150*time.Millisecond {
		t.Errorf("Scrape took %v; client timeout of 50ms should abort well before the 200ms handler", elapsed)
	}
}
