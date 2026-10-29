package duplicates

var ready bool

func init() {
	ready = true
}

func helper() {}

func init() {
	ready = false
}

func (S) Value() {}

type S struct{}

var later func()

func assign() {
	later = func() {}
}
