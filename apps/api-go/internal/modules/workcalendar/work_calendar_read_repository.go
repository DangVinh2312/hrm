package workcalendar

import (
	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/modules/permission"
	"hrm/api-go/internal/modules/schedulecore"
)

type storedYear struct {
	Version    string
	Holidays   string
	MakeupDays string
}

// readYear is workCalendar.read: holidays and makeup days of one year in effect at the current version.
// The scope is the singleton calendar, so a caller the plan does not reach finds nothing.
func readYear(c authority.QueryContext, year int) (authority.QueryResult[YearView], error) {
	var result authority.QueryResult[YearView]
	args, at, err := c.Scope.Args(permission.WorkCalendarID, year)
	if err != nil {
		return result, err
	}
	rows, err := c.Tx.Query(`SELECT r.version::text AS version, y.holidays::text AS holidays, y.makeup::text AS "makeupDays"
           FROM work_calendar r CROSS JOIN LATERAL (
             SELECT COALESCE(json_agg(json_build_object('date', to_char(d.day,'YYYY-MM-DD'), 'name', d.name) ORDER BY d.day)
                      FILTER (WHERE d.kind = 'paid_holiday'), '[]'::json) AS holidays,
                    COALESCE(json_agg(json_build_object('date', to_char(d.day,'YYYY-MM-DD'),
                               'asWeekday', d.as_weekday, 'frameSource', d.frame_source) ORDER BY d.day)
                      FILTER (WHERE d.kind = 'makeup_workday'), '[]'::json) AS makeup
               FROM (SELECT DISTINCT ON (x.day) x.day, x.kind, x.name, x.as_weekday, x.frame_source
                      FROM work_calendar_change x
                      WHERE x.day >= make_date(CAST(`+at(2)+` AS int),1,1)
                        AND x.day < make_date(CAST(`+at(2)+` AS int) + 1,1,1)
                        AND x.version <= r.version
                      ORDER BY x.day, x.version DESC) d) y
          WHERE `+c.Scope.SQL+` AND r.id = CAST(`+at(1)+` AS uuid)`, args...)
	if err != nil {
		return result, err
	}
	stored, err := pgx.CollectRows(rows, pgx.RowToStructByPos[storedYear])
	if err != nil || len(stored) == 0 {
		return result, err
	}
	holidays, err := schedulecore.DecodeStored[[]Holiday]([]byte(stored[0].Holidays))
	if err != nil {
		return result, err
	}
	makeup, err := schedulecore.DecodeStored[[]MakeupDay]([]byte(stored[0].MakeupDays))
	if err != nil {
		return result, err
	}
	view := YearView{Version: stored[0].Version, Year: year, Holidays: holidays, MakeupDays: makeup}
	return authority.QueryResult[YearView]{Found: true, Value: view}, nil
}
