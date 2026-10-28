package fixtures

// A //line directive renumbers what fset.Position reports; the gate must
// see the physical lines the file has (LAB-7587).

//line other.go:1
func Long() {
	_ = 1
	_ = 2
	_ = 3
//line other.go:2
	_ = 4
}

func After() {
}
