package setting

import (
	"context"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/modules/settingcore"
)

// Operations are the queries and commands of the settings, to register with authority.New.
func Operations() []authority.Operation {
	return []authority.Operation{listQuery, profileQuery, historyQuery, securityQuery, updateRuleCommand, updateProfileCommand}
}

// Service is the setting operations bound to the authority; it implements Port.
type Service struct{ authorization *authority.Authorization }

func NewService(a *authority.Authorization) *Service { return &Service{authorization: a} }

// List is setting.read, with a display hint of which groups the caller may update.
func (s *Service) List(ctx context.Context, secret string) (ListView, bool, error) {
	result, err := authority.Read(ctx, s.authorization, secret, listQuery, none{})
	if err != nil || !result.Found {
		return ListView{}, false, err
	}
	resource := string(keys.SettingResourceSetting)
	permits, err := s.authorization.PermitsMany(ctx, secret, []authority.PermitQuery{
		{{Resource: resource, Action: string(keys.SettingActionUpdateRule)}},
		{{Resource: resource, Action: string(keys.SettingActionUpdateProfile)}},
	})
	if err != nil {
		return ListView{}, false, err
	}
	return ListView{Settings: result.Value, CanUpdate: CanUpdate{Rule: permits[0], Profile: permits[1]}}, true, nil
}

func (s *Service) Profile(ctx context.Context, secret string) (ProfileView, bool, error) {
	result, err := authority.Read(ctx, s.authorization, secret, profileQuery, none{})
	return result.Value, result.Found, err
}

func (s *Service) Security(ctx context.Context, secret string) (SecurityView, bool, error) {
	result, err := authority.Read(ctx, s.authorization, secret, securityQuery, none{})
	return result.Value, result.Found, err
}

func (s *Service) History(ctx context.Context, secret string, query HistoryQuery) (HistoryView, bool, error) {
	result, err := authority.Read(ctx, s.authorization, secret, historyQuery, query)
	return result.Value, result.Found, err
}

// Update runs the command of the key's group. The anchor always exists, so a command that does not reach
// it means no grant: 403.
func (s *Service) Update(ctx context.Context, secret string, input UpdateInput) (UpdateResult, error) {
	def, ok := settingcore.Lookup(string(input.Key))
	if !ok {
		return UpdateResult{}, apperror.ErrInvalidRequest
	}
	var command *authority.Command[UpdateInput, UpdateResult]
	switch def.Group {
	case settingcore.GroupRule:
		command = updateRuleCommand
	case settingcore.GroupProfile:
		command = updateProfileCommand
	default:
		return UpdateResult{}, apperror.ErrInvalidRequest
	}
	result, err := authority.Execute(ctx, s.authorization, secret, command, input)
	if err != nil {
		return UpdateResult{}, err
	}
	if !result.Found {
		return UpdateResult{}, apperror.ErrAccessDenied
	}
	return result.Value, nil
}
