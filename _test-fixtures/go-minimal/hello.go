package minimal

func Greet(name string) string {
	if name == "" {
		return "hello, world"
	}
	return "hello, " + name
}
