package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const fixtureDir = "../../../../_test-fixtures/size-gate/extract/go"

func TestGoldens(t *testing.T) {
	for _, name := range []string{"shapes", "duplicates", "linedirective"} {
		t.Run(name, func(t *testing.T) {
			src := filepath.Join(fixtureDir, name+".go")
			want := readGolden(t, filepath.Join(fixtureDir, name+".golden.json"))
			got := extract([]string{src})
			assertEqual(t, want, got[src])
		})
	}
}

func TestParseErrorIsPerFile(t *testing.T) {
	bad := filepath.Join(t.TempDir(), "broken.go")
	writeFile(t, bad, "package broken\n\nfunc Bad( {\n")
	good := filepath.Join(fixtureDir, "duplicates.go")

	got := extract([]string{bad, good})

	if got[bad].Error == "" || got[bad].Functions == nil || len(got[bad].Functions) != 0 {
		t.Fatalf("broken file: want error and empty functions, got %+v", got[bad])
	}
	if len(got[good].Functions) != 6 || got[good].Error != "" {
		t.Fatalf("good file not extracted: %+v", got[good])
	}
}

func TestMissingFile(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "absent.go")
	got := extract([]string{missing})
	if !strings.Contains(got[missing].Error, "absent.go") {
		t.Fatalf("want error naming the file, got %q", got[missing].Error)
	}
	if got[missing].Functions == nil {
		t.Fatal("functions must be an empty array, not null")
	}
}

func TestRunWritesJSON(t *testing.T) {
	empty := filepath.Join(t.TempDir(), "empty.go")
	writeFile(t, empty, "package empty\n")
	var out bytes.Buffer

	if err := run([]string{empty}, &out); err != nil {
		t.Fatalf("run: %v", err)
	}

	want := `{"` + empty + `":{"functions":[]}}`
	if strings.TrimSpace(out.String()) != want {
		t.Fatalf("stdout:\n got %s\nwant %s", out.String(), want)
	}
}

func readGolden(t *testing.T, path string) fileResult {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var r fileResult
	if err := json.Unmarshal(data, &r); err != nil {
		t.Fatalf("decode golden: %v", err)
	}
	return r
}

func assertEqual(t *testing.T, want, got fileResult) {
	t.Helper()
	if reflect.DeepEqual(want, got) {
		return
	}
	w, _ := json.MarshalIndent(want, "", "  ")
	g, _ := json.MarshalIndent(got, "", "  ")
	t.Fatalf("mismatch\nwant %s\n got %s", w, g)
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
}
