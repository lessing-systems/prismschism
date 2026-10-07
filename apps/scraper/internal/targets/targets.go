// Package targets loads and validates the list of LiteLLM backends that the
// scraper polls. Backends are declared in a YAML file and each backend's API
// key is resolved from the environment variable named by its key_env field.
//
// Security contract: error messages and logs produced by this package never
// contain the value of an API key. They reference only the name of the
// environment variable that was expected, the target name, and file paths.
package targets

import (
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Target describes a single LiteLLM backend to scrape.
//
// APIKey is resolved at load time from the environment variable named by
// KeyEnv and is deliberately excluded from YAML (and any other) marshaling via
// the `yaml:"-"` tag, so a key value can never be written back out to disk or
// leaked through serialization.
type Target struct {
	Name   string `yaml:"name"`
	URL    string `yaml:"url"`
	KeyEnv string `yaml:"key_env"`
	APIKey string `yaml:"-"`
}

// Config is the top-level shape of a targets YAML file. The only permitted
// key is `backends`, a non-empty list of Target entries.
type Config struct {
	Backends []Target `yaml:"backends"`
}

// Load reads the targets YAML file at path, validates it, resolves each
// target's API key from the environment, and returns the list of targets.
//
// Validation performed:
//   - the file must exist and be valid YAML;
//   - unknown keys are rejected (yaml KnownFields), so inline `key:` values
//     and any extra fields are never accepted;
//   - `backends:` must be present and non-empty;
//   - each target's name, url and key_env must be non-empty after trimming.
//
// For each target, APIKey is set to the value of the environment variable
// named by its KeyEnv field. If that variable is unset or blank, Load returns
// an error naming the target and the variable. No error message ever contains
// a key value.
func Load(path string) ([]Target, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read targets file %s: %w", path, err)
	}

	var cfg Config
	dec := yaml.NewDecoder(strings.NewReader(string(data)))
	// Reject any key that is not part of Config / Target. This is what makes
	// inline key values (e.g. `key: ...`) impossible to smuggle in.
	dec.KnownFields(true)
	if err := dec.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("parse targets file %s: %w", path, err)
	}

	if len(cfg.Backends) == 0 {
		return nil, fmt.Errorf("targets file %s: backends list must not be empty", path)
	}

	for i := range cfg.Backends {
		t := &cfg.Backends[i]

		// Trim whitespace on all fields so " url:  " is treated as blank.
		t.Name = strings.TrimSpace(t.Name)
		t.URL = strings.TrimSpace(t.URL)
		t.KeyEnv = strings.TrimSpace(t.KeyEnv)

		if t.Name == "" {
			return nil, fmt.Errorf("targets file %s: backend index %d: name is empty", path, i)
		}
		if t.URL == "" {
			return nil, fmt.Errorf("targets file %s: target %q (index %d): url is empty", path, t.Name, i)
		}
		if t.KeyEnv == "" {
			return nil, fmt.Errorf("targets file %s: target %q (index %d): key_env is empty", path, t.Name, i)
		}

		key := strings.TrimSpace(os.Getenv(t.KeyEnv))
		if key == "" {
			// Intentionally references only the variable NAME and the target
			// name. The value of the (empty) variable is never interpolated.
			return nil, fmt.Errorf("target %q: environment variable %s is not set", t.Name, t.KeyEnv)
		}
		t.APIKey = key
	}

	return cfg.Backends, nil
}
