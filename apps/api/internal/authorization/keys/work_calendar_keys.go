package keys

type WorkCalendarResource string

const (
	WorkCalendarResourceWorkCalendar WorkCalendarResource = "workCalendar"
)

type WorkCalendarAction string

const (
	WorkCalendarActionRead           WorkCalendarAction = "read"
	WorkCalendarActionManage         WorkCalendarAction = "manage"
	WorkCalendarActionManageSchedule WorkCalendarAction = "manageSchedule"
)

type WorkCalendarTemplate string

const (
	WorkCalendarTemplateCalendar WorkCalendarTemplate = "calendar"
)
