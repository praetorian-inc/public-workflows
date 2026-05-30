package release

import "testing"

func TestGreet(t *testing.T) {
	if got := Greet(""); got != "Hello, world!" {
		t.Errorf("Greet('') = %q, want %q", got, "Hello, world!")
	}
	if got := Greet("Go"); got != "Hello, Go!" {
		t.Errorf("Greet('Go') = %q, want %q", got, "Hello, Go!")
	}
}
