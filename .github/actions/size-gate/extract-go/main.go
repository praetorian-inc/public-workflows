// Command extract-go prints the line range of every Go function body in the
// files named on the command line, as one JSON object on stdout. It parses
// only; it never type-checks or executes the input.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
)

type function struct {
	Name        string `json:"name"`
	Start       int    `json:"start"`
	End         int    `json:"end"`
	IsComponent bool   `json:"isComponent"`
}

// comment is one comment, delimiters included, on physical lines.
type comment struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Text  string `json:"text"`
}

type fileResult struct {
	Functions []function `json:"functions"`
	Comments  []comment  `json:"comments"`
	Error     string     `json:"error,omitempty"`
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "extract-go:", err)
		os.Exit(1)
	}
}

// run extracts every path and writes the combined result as JSON to w.
func run(paths []string, w io.Writer) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	return enc.Encode(extract(paths))
}

// extract parses each path independently; a file that cannot be read or
// parsed gets an error entry and does not stop the others.
func extract(paths []string) map[string]fileResult {
	results := make(map[string]fileResult, len(paths))
	for _, path := range paths {
		results[path] = extractFile(path)
	}
	return results
}

func extractFile(path string) fileResult {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution|parser.ParseComments)
	if err != nil {
		return fileResult{Functions: []function{}, Comments: []comment{}, Error: err.Error()}
	}
	c := &collector{fset: fset, hints: map[*ast.FuncLit]string{}, functions: []function{}}
	ast.Walk(&visitor{c: c}, file)
	return fileResult{Functions: c.functions, Comments: comments(fset, file)}
}

// comments lists every comment in source order, one entry per comment (not
// per group), on physical lines like the functions.
func comments(fset *token.FileSet, file *ast.File) []comment {
	out := []comment{}
	for _, group := range file.Comments {
		for _, c := range group.List {
			out = append(out, comment{
				Start: fset.PositionFor(c.Pos(), false).Line,
				End:   fset.PositionFor(c.End(), false).Line,
				Text:  c.Text,
			})
		}
	}
	return out
}

// collector accumulates functions in source order. hints maps a literal to
// the variable or callee name its parent node gave it.
type collector struct {
	fset      *token.FileSet
	hints     map[*ast.FuncLit]string
	functions []function
}

// visitor carries the qualified name of the nearest enclosing function.
type visitor struct {
	c         *collector
	enclosing string
}

func (v *visitor) Visit(node ast.Node) ast.Visitor {
	switch n := node.(type) {
	case *ast.FuncDecl:
		if n.Body == nil {
			return nil
		}
		return v.enter(declName(n), n.Pos(), n.Body.Rbrace)
	case *ast.FuncLit:
		return v.enter(v.literalName(n), n.Pos(), n.Body.Rbrace)
	case *ast.AssignStmt:
		v.hintAssigned(n.Lhs, n.Rhs)
	case *ast.ValueSpec:
		v.hintAssigned(identExprs(n.Names), n.Values)
	case *ast.CallExpr:
		v.hintArgs(n)
	}
	return v
}

// enter records physical lines: PositionFor(_, false) ignores //line
// directives, which could otherwise renumber a long function short (LAB-7587).
func (v *visitor) enter(name string, start, end token.Pos) ast.Visitor {
	v.c.functions = append(v.c.functions, function{
		Name:  name,
		Start: v.c.fset.PositionFor(start, false).Line,
		End:   v.c.fset.PositionFor(end, false).Line,
	})
	return &visitor{c: v.c, enclosing: name}
}

func (v *visitor) literalName(lit *ast.FuncLit) string {
	hint := v.c.hints[lit]
	if hint == "" {
		hint = "anon"
	}
	prefix := ""
	if v.enclosing != "" {
		prefix = v.enclosing + ">"
	}
	return prefix + "func:" + hint
}

// hintAssigned names literals on the right of `x := func(){}`, `x = ...`
// and `var x = ...` after the identifier at the same position on the left.
func (v *visitor) hintAssigned(lhs, rhs []ast.Expr) {
	if len(lhs) != len(rhs) {
		return
	}
	for i, value := range rhs {
		lit, ok := value.(*ast.FuncLit)
		if !ok {
			continue
		}
		if ident, ok := lhs[i].(*ast.Ident); ok {
			v.c.hints[lit] = ident.Name
		}
	}
}

// hintArgs names literals passed as call arguments after the callee as
// written, when the callee is an identifier or selector chain.
func (v *visitor) hintArgs(call *ast.CallExpr) {
	callee := render(call.Fun)
	if callee == "" {
		return
	}
	for _, arg := range call.Args {
		if lit, ok := arg.(*ast.FuncLit); ok {
			v.c.hints[lit] = callee
		}
	}
}

func declName(decl *ast.FuncDecl) string {
	if decl.Recv == nil || len(decl.Recv.List) == 0 {
		return decl.Name.Name
	}
	return receiverType(decl.Recv.List[0].Type) + "." + decl.Name.Name
}

// receiverType strips pointers, parentheses and type parameters from a
// receiver: `*T[K]` becomes `T`.
func receiverType(expr ast.Expr) string {
	switch e := expr.(type) {
	case *ast.StarExpr:
		return receiverType(e.X)
	case *ast.ParenExpr:
		return receiverType(e.X)
	case *ast.IndexExpr:
		return receiverType(e.X)
	case *ast.IndexListExpr:
		return receiverType(e.X)
	case *ast.Ident:
		return e.Name
	}
	return "anon"
}

// render returns an identifier or selector chain as written (`g.Go`,
// `sort.Slice`), or "" for any other expression.
func render(expr ast.Expr) string {
	switch e := expr.(type) {
	case *ast.Ident:
		return e.Name
	case *ast.SelectorExpr:
		x := render(e.X)
		if x == "" {
			return ""
		}
		return x + "." + e.Sel.Name
	}
	return ""
}

func identExprs(idents []*ast.Ident) []ast.Expr {
	exprs := make([]ast.Expr, len(idents))
	for i, ident := range idents {
		exprs[i] = ident
	}
	return exprs
}
