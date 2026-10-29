package comments

const a = "//nolint" // real trailing
const b = `/* x */`

/* a block
   over three lines */
func F() string {
	return "# noqa" + b
}
