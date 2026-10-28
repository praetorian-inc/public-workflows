package shapes

import "sort"

// Plain is a doc-commented function.
// Its start is the func line, not this comment.
func Plain() int {
	return 1
}

type T[K comparable] struct{ v K }

type S struct{}

func (s *S) Ptr() {}

func (t *T[K]) Gen() K {
	return t.v
}

var handler = func() {
}

func Outer(xs []int) {
	cb := func(a, b int) bool {
		return a < b
	}
	sort.Slice(xs, func(i, j int) bool {
		return cb(xs[i], xs[j])
	})
	run(func() {
		inner := func() {}
		inner()
	})
	defer func() {}()
}

func run(f func()) { f() }
