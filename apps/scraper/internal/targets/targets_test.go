package targets

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeYAML writes content to a unique temp file and returns its path. It uses
// t.TempDir() so cleanup is automatic and the test stays hermetic.
func writeYAML(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "targets.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write temp yaml file: %v", err)
	}
	return path
}

func TestLoadValid(t *testing.T) {
	const (
		keyA = "sk-test-alpha-0001"
		keyB = "sk-test-beta-0002"
	)
	t.Setenv("SCRAPER_KEY_A", keyA)
	t.Setenv("SCRAPER_KEY_B", keyB)

	doc := `
backends:
  - name: alpha
    url: http://localhost:8001
    key_env: SCRAPER_KEY_A
  - name: beta
    url: http://localhost:8002
    key_env: SCRAPER_KEY_B
`
	got, err := Load(writeYAML(t, doc))
	if err != nil {
		t.Fatalf("Load returned unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 targets, got %d", len(got))
	}

	if got[0].Name != "alpha" {
		t.Errorf("backend[0].Name = %q, want %q", got[0].Name, "alpha")
	}
	if got[0].URL != "http://localhost:8001" {
		t.Errorf("backend[0].URL = %q, want %q", got[0].URL, "http://localhost:8001")
	}
	if got[0].KeyEnv != "SCRAPER_KEY_A" {
		t.Errorf("backend[0].KeyEnv = %q, want %q", got[0].KeyEnv, "SCRAPER_KEY_A")
	}
	if got[0].APIKey != keyA {
		t.Errorf("backend[0].APIKey not resolved to the env value")
	}

	if got[1].Name != "beta" {
		t.Errorf("backend[1].Name = %q, want %q", got[1].Name, "beta")
	}
	if got[1].URL != "http://localhost:8002" {
		t.Errorf("backend[1].URL = %q, want %q", got[1].URL, "http://localhost:8002")
	}
	if got[1].KeyEnv != "SCRAPER_KEY_B" {
		t.Errorf("backend[1].KeyEnv = %q, want %q", got[1].KeyEnv, "SCRAPER_KEY_B")
	}
	if got[1].APIKey != keyB {
		t.Errorf("backend[1].APIKey not resolved to the env value")
	}
}

func TestLoadMissingKeyEnv(t *testing.T) {
	const (
		envVar     = "LITELLM_MASTER_KEY"
		targetName = "prod-gateway"
	)

	// Guarantee the referenced variable is genuinely unset for the test and
	// restore its previous state (if any) when the test finishes.
	if prev, had := os.LookupEnv(envVar); had {
		os.Unsetenv(envVar)
		t.Cleanup(func() { t.Setenv(envVar, prev) })
	} else {
		t.Cleanup(func() { os.Unsetenv(envVar) })
	}

	doc := "backends:\n  - name: prod-gateway\n    url: http://localhost:8003\n    key_env: LITELLM_MASTER_KEY\n"

	_, err := Load(writeYAML(t, doc))
	if err == nil {
		t.Fatal("expected Load to error when key_env variable is unset")
	}
	msg := err.Error()
	if !strings.Contains(msg, envVar) {
		t.Errorf("error should mention the env var name %q, got: %q", envVar, msg)
	}
	if !strings.Contains(msg, targetName) {
		t.Errorf("error should mention the target name %q, got: %q", targetName, msg)
	}
	// With the variable unset there is no key value in existence, so nothing
	// secret can appear in the message. The name+envvar checks above are the
	// real assertions required here.
}

func TestLoadEmptyBackends(t *testing.T) {
	doc := "backends: []\n"
	if _, err := Load(writeYAML(t, doc)); err == nil {
		t.Fatal("expected Load to error on an empty backends list")
	}
}

func TestLoadUnknownFieldRejected(t *testing.T) {
	t.Setenv("SCRAPER_KEY_A", "sk-test-alpha-0001")

	// An inline `key:` field is not part of Target. With KnownFields(true)
	// this must be rejected, proving keys are never accepted inline.
	doc := "backends:\n  - name: alpha\n    url: http://localhost:8001\n    key_env: SCRAPER_KEY_A\n    key: inline\n"

	_, err := Load(writeYAML(t, doc))
	if err == nil {
		t.Fatal("expected Load to reject the unknown inline `key` field")
	}
}

func TestLoadMissingFile(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "does-not-exist.yaml")
	if _, err := Load(missing); err == nil {
		t.Fatal("expected Load to error on a missing file")
	}
}
