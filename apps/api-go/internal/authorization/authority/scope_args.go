package authority

import (
	"errors"
	"strconv"

	"hrm/api-go/internal/authorization/compiler"
)

var errScopeParameter = errors.New("scope parameter has no kind")

// Args are the statement arguments for a query that embeds the scope: the plan's parameters first, then
// values. at(i) is the placeholder of the i-th value (1-based); any other index names no parameter, so
// the statement fails instead of reading a plan parameter.
func (s Scope) Args(values ...any) ([]any, func(int) string, error) {
	args := make([]any, 0, len(s.Parameters)+len(values))
	for _, param := range s.Parameters {
		arg, err := paramArg(param)
		if err != nil {
			return nil, nil, err
		}
		args = append(args, arg)
	}
	base := len(args)
	args = append(args, values...)
	at := func(index int) string {
		if index < 1 {
			return ""
		}
		return "$" + strconv.Itoa(base+index)
	}
	return args, at, nil
}

func paramArg(param compiler.Param) (any, error) {
	switch param.Kind() {
	case compiler.ParamText:
		text, _ := param.AsText()
		return text, nil
	case compiler.ParamBool:
		flag, _ := param.AsBool()
		return flag, nil
	case compiler.ParamInt:
		number, _ := param.AsInt()
		return number, nil
	case compiler.ParamBytes:
		raw, _ := param.AsBytes()
		return raw, nil
	}
	return nil, errScopeParameter
}
