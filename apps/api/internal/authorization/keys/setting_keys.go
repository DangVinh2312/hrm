package keys

type SettingResource string

const (
	SettingResourceSetting SettingResource = "setting"
)

type SettingAction string

const (
	SettingActionRead          SettingAction = "read"
	SettingActionReadProfile   SettingAction = "readProfile"
	SettingActionUpdateRule    SettingAction = "updateRule"
	SettingActionUpdateProfile SettingAction = "updateProfile"
)

type SettingTemplate string

const (
	SettingTemplateSetting SettingTemplate = "setting"
)
