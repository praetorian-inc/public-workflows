package minimal

import "testing"

func TestGreet_Default(t *testing.T) {
	got := Greet("")
	want := "hello, world"
	if got != want {
		t.Errorf("Greet(\"\") = %q, want %q", got, want)
	}
}

func TestGreet_Named(t *testing.T) {
	got := Greet("praetorian")
	want := "hello, praetorian"
	if got != want {
		t.Errorf("Greet(\"praetorian\") = %q, want %q", got, want)
	}
}
