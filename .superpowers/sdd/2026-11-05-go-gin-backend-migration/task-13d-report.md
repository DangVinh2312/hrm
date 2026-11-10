# Báo cáo Task 13d — ghép M5 và ma trận tổng

Trạng thái: XONG, review độc lập Approved sau vòng sửa 1 (xem cuối báo cáo). Base `1402120`, commit chứa báo cáo này; không push. Agent tiếp quản sau usage limit của implementer trước; giữ nguyên phần đúng và bổ sung coverage phát hiện khi đối chiếu tracker.

## Thay đổi

- `internal/app/m1_matrix_integration_test.go`: tách `checkMatrixRow`, giữ nguyên điều kiện cũ để guard tổng tái dùng.
- `internal/app/m5_matrix_integration_test.go`: danh sách 11 route M5 tường minh; `TestEveryM5RouteHasAFullMatrixIncludingAuthenticatedCommands` ghép m5a/b/c/e, gồm decision/cancel authenticated và cả hai nhánh pending/approved của cancel; kiểm 65 migrated routes.
- `internal/app/m5_behavior_integration_test.go`: workflow HTTP submit → balance → điều chỉnh giảm → reconciliation → detail → khôi phục → lead → COO → cancel → nộp lại slot; Root final/cancel có effect và audit target. Ngày lễ/làm bù dựng qua route Go M4, kết thúc membership qua route M1; submit bị từ chối không ghi. Menu approvals theo quyền/assignment hiện hành dù không có đơn đang chờ.
- `internal/authorization/authority/hrm_parity_integration_test.go`: SQL gateway/evaluator trên mọi dòng workRequest.read và employee.readLeaveBalance, sáu principal, owner/lead/decider/leadRejectedLeadOwned và nhiều trạng thái; ít nhất năm scope không rỗng và không toàn bộ.
- `internal/modules/workrequest/work_request_workflow_integration_test.go`: pending giữ đúng quỹ, replay lúc hết quỹ, unpaid không dùng quỹ và không được debit qua effect nội bộ, reject giải phóng quỹ để cùng key nộp lại; role runtime tự duyệt theo permission; team/lead hiện hành; hai role vẫn hai bước; account mới liên kết không tự duyệt; COO chỉ đọc đơn lead-owned bị từ chối và không quyết định nó.
- `internal/modules/workrequest/work_request_schema_integration_test.go`: ACL data/authority và CHECK/FK/UNIQUE của request, segment, decision, idempotency; reject cần reason.
- `internal/modules/workrequest/work_request_setting_integration_test.go`: hạn WFH hiện hành ở submit/final, tăng hạn cho cùng key retry, giảm hạn không đổi approved, hạn 0; cửa sổ quá khứ/tương lai theo DB clock, thu hẹp cửa sổ không chặn duyệt đơn cũ; max days 3 rồi 31. Settings thay bằng SQL disposable, không tuyên bố kiểm route settings trong test này.
- `contract/test-port-tracker.md`, ghi chú Task 13 trong plan: đối chiếu từng ca, ghi symbol cụ thể; tách close/reopen/sheet/snapshot M6 và report/export/query-count M7.

Không đổi runtime, schema, quyền, API contract, dependencies, NestJS hay web. Không sửa progress/handoff của parent. Không thêm import production hay cạnh DAG.

## Phạm vi và quyết định

Giữ ruling 85–92 và minor m3: queue loại owner_account_id; decision kiểm thêm e.account_id. Test account mới kiểm lệnh từ chối, không tự sửa semantics queue.

M5 có bốn hash: leave.adjust, submit, decision, cancel. Nơi thứ năm là attendance adjustment ở `apps/api/src/modules/attendance/attendance.service.ts:39`, thuộc Task 14. Period :249 vẫn cần cuộc đua với close thật M6. Không tick hai phần tổng này.

Tracker setting cũ gộp mọi thứ vào M1; đọc source phát hiện ba ca M5 :66/:142/:171 còn thiếu hành vi đổi giá trị, nên thêm test. :98/:181/:194 cần report/close/export để Task 14–15; :209 query-count chéo ghi đích Task 15 cùng toàn bộ số query kỳ vọng. Không đánh dấu cả file khi còn phần chưa chuyển.

Các command fixture cũ trong authorization workflow/root-audit được thay bằng command thật của M5 và tests nền authority: bắt buộc audit, bản sao command không đăng ký, guard Root, atomic rollback. Không lặp lại lớp test nền đã có.

## RED qua overlay ngoài repo

Recipe gốc `/private/tmp/hrm-13d-mutations.py`, overlay/bản sao `/private/tmp/hrm-13d-mutants/`; source thật không bị đột biến. Log mỗi ca `/private/tmp/hrm-13d-red-<tên>.log`. 13 mutant đầu của recipe và bốn mutant bổ sung đều RED hành vi; không dùng syntax/compile failure.

Năm ca đầu do implementer trước chạy, đã đọc log thô; log không lưu đầy đủ command line nên không gán flags chưa được chứng minh. Các ca tiếp quản dùng:
`go test -race -tags integration -count=1 -overlay /private/tmp/hrm-13d-mutants/<tên>.json <package> -run '^<test>$'`.

| Overlay              | Test/package                                                                           | Bằng chứng RED                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| guard-route          | app / TestEveryM5RouteHasAFullMatrixIncludingAuthenticatedCommands                     | Bỏ cancel khỏi MigratedRoutes: 64 thay 65 và thiếu route, 0.095s                                                                                                        |
| guard-cell           | app / cùng guard                                                                       | Decision thiếu signed-out cell, 0.095s                                                                                                                                  |
| root-effect          | app / TestM5WorkflowReconciliationDetailApprovalAndCancellation                        | Root final approved nhưng không có debit, 7.321s                                                                                                                        |
| calendar-holiday     | app / TestM5CalendarDaysAndEndedMembershipRejectSubmitsWithoutWrites                   | Bỏ holiday: submit nhận 201, có request được ghi, 7.460s                                                                                                                |
| membership-ended     | app / cùng test                                                                        | Bỏ currentWindow: membership hết hạn đi qua bước membership và trả nonWorkingDay thay teamNotMember, 6.015s; chứng minh thứ tự/loại từ chối, không phải đã ghi được đơn |
| runtime-permission   | workrequest / TestSelfApprovalFollowsRuntimePermissionsAndTheirRevocation              | Ép initialState(false): role có permission vẫn pending, 6.667s                                                                                                          |
| leave-reservation    | workrequest / TestPendingLeaveReservesAnExactBalanceAndRejectingItFreesTheSameKey      | Bỏ AssertAvailable: vượt quỹ được ghi, replay/state khác, 6.466s                                                                                                        |
| root-lead-fallback   | workrequest / TestTheCurrentTeamAndLeadControlPendingRequests                          | Root bỏ qua current approver và đổi state, 6.362s                                                                                                                       |
| self-linked-account  | workrequest / TestTwoRolesStillRequireTwoDecisionsAndANewLinkedAccountCannotSelfDecide | Bỏ e.account_id: account mới tự duyệt được và đổi state, 6.299s                                                                                                         |
| coo-read-rejection   | workrequest / TestCooOnlyReadsALeadOwnedRequestRejectedAtTheLeadStep                   | Đổi permission readLeadRejected thành read: COO mất detail hợp lệ, 6.138s                                                                                               |
| schema-reject-reason | workrequest / TestRequestSegmentsDecisionsAndClaimsKeepTheirACLAndChecks               | Drop CHECK: insert reject thiếu reason không lỗi, 6.582s                                                                                                                |
| parity-owner         | authority / TestWorkRequestAndLeaveScopesMatchTheEvaluatorOnEveryRow                   | Binding owner trỏ decider: SQL lệch evaluator ở ba principal, 5.930s                                                                                                    |
| approvals-menu       | app / TestM5ApprovalsMenuFollowsPermissionsWithoutWaitingRequests                      | Ép menu false: lead/COO/Root mất approvals, 7.401s                                                                                                                      |
| setting-final-limit  | workrequest / TestChangedSettingsApplyToNewSubmitsAndFinalDecisions                    | Final dùng 4 thay stored limit 2: nhận lệnh phải bị từ chối, 6.872s                                                                                                     |
| setting-window       | workrequest / cùng test                                                                | Dùng 7/90 mặc định: vượt cửa sổ tương lai vẫn submit được, 7.094s                                                                                                       |
| setting-max-days     | workrequest / cùng test                                                                | Dùng 31 thay setting 3: request bốn ngày vẫn được ghi, 7.424s                                                                                                           |
| unpaid-debit         | workrequest / TestPendingLeaveReservesAnExactBalanceAndRejectingItFreesTheSameKey      | Bỏ kind guard: chạy tới FK thay ErrNotAnnualLeave, 6.819s                                                                                                               |

Bốn overlay bổ sung chỉ thay: final limit thành 4; window args thành 7/90; max days thành 31; bỏ điều kiện Kind của ApplyApproved. Tất cả exit 1 với assertion ở test tương ứng.

## Lệnh và kết quả

Mọi lệnh nặng mới chạy riêng, tuần tự sau `bash /Users/vinhdq2312/Documents/personal/hrm/.superpowers/sdd/2026-11-05-go-gin-backend-migration/waitload.sh`, escalation cho tải máy/Docker/localhost, `GOCACHE=/private/tmp/hrm-go-cache`. Chỉ PostgreSQL disposable; không đọc seed/env/secret/PII, không chạm staging/production. Không có test nặng agent khác được cho chạy cùng lúc.

Lịch sử trước tiếp quản: focused workrequest GREEN 12.928s; app lượt đầu FAIL 9.399s do fixture JSON v2 thiếu tags, sửa fixture rồi GREEN r2 9.930s/r3 10.084s; parity GREEN 7.141s; reservation GREEN 7.554s; menu GREEN 7.988s. Các log này không lưu đủ command line; không dùng chúng thay gate mới.

| Lệnh mới (trong apps/api-go nếu không ghi khác)                                                                                        | Exit / kết quả                         |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| go test -race -tags integration -count=1 ./internal/modules/workrequest -run '^TestChangedSettingsApplyToNewSubmitsAndFinalDecisions$' | 0, 8.408s; hrm-13d-setting-green.log   |
| go build ./...                                                                                                                         | 0; hrm-13d-gate-build.log              |
| go vet ./...                                                                                                                           | 0; hrm-13d-gate-vet.log                |
| go vet -tags integration ./...                                                                                                         | 0; hrm-13d-gate-vet-integration.log |
| go test -race -count=1 ./internal/...                                                                                                  | 0; 32 package ok, permission không có test unit; hrm-13d-gate-unit.log |
| go test -race -tags integration -count=1 -p 1 ./internal/modules/workrequest                                                           | 0, 114.425s; hrm-13d-gate-workrequest.log |
| cùng integration flags, ./internal/authorization/authority                                                                             | 0, 22.896s; hrm-13d-gate-authority.log |
| cùng integration flags, ./internal/app                                                                                                 | 0, 87.338s; hrm-13d-gate-app.log |
| go tool golangci-lint run                                                                                                              | lượt 1 exit 1 (1 issue contextcheck tại work_request_schema_integration_test.go:44), đã sửa; r2 exit 0, 0 issues; hrm-13d-gate-lint*.log |
| go test -race -tags integration -count=1 ./internal/modules/workrequest -run '^TestRequestSegmentsDecisionsAndClaimsKeepTheirACLAndChecks$' (chạy lại sau sửa contextcheck) | 0, 13s tổng (test 6.777s); hrm-13d-gate-schema.log |
| go test -count=1 ./test                                                                                                                | 0, 9s (test 4.723s); hrm-13d-gate-test.log |
| go vet -tags integration ./... (chạy lại sau sửa file schema)                                                                          | 0, 1s; hrm-13d-gate-vet2.log |
| gofmt -l . (chạy lại)                                                                                                                  | 0, rỗng; hrm-13d-gate-gofmt.log |
| gofmt -l .                                                                                                                             | 0, rỗng sau sửa format hai file Go mới |
| pnpm test:browser (root)                                                                                                               | 0, 170s, 30 passed; hrm-13d-gate-browser.log |
| Prettier đúng Markdown sửa                                                                                                             | plan exit 0; report lượt đầu exit 1, sửa format bằng patch rồi exit 0; tracker thuộc .prettierignore |
| git diff --check                                                                                                                       | 0 tại checkpoint 01:10; chạy lại ở gate cuối: 0 |

`gofmt -d` ban đầu exit 1 vì hai file Go chưa format (struct Menus, căn map key); sửa bằng patch, không format rộng. Một lần tìm file `authority/command_integration_test.go` exit 2 vì tên thực là `authority_commands_integration_test.go`; đã tìm lại bằng rg. Đây không phải test/gate fail.

## Review và phần còn lại

Review độc lập (opus, chỉ đọc diff `review-t13d.diff` và file hiện tại, không nhận kết luận implementer): lượt 1 Needs fixes với 1 Important (I1: tracker ghi ca Root audit target vắng TS :38 đã thay thế nhưng không test M5 nào kiểm) và 5 Minor. Sửa I1, M1, M2 ở vòng sửa 1 (dưới); re-review delta: cả ba ADDRESSED, không finding mới, Approved.

Minor giữ lại, không sửa (ghi nhận của điều phối viên):

- M3: `m5Routes` chép tay, không đối chiếu tự động với `route-ownership.md`; brief yêu cầu danh sách tường minh. Nếu ownership thêm route M5 chưa migrate thì guard không đỏ.
- M4: tracker `hrm-authorization-workflow` :45 "thay bằng" dựa vào parity SQL/evaluator và matrix scope ở module khác; chưa có test tập nhìn thấy kỳ vọng theo từng người như TS (L1 → qA, L2 → qB/qD, C rỗng rồi qB, H toàn bộ).
- M5: `TestCooOnlyReadsALeadOwnedRequestRejectedAtTheLeadStep` chưa kiểm phần "các caller khác vẫn 404" của TS :830.

Chưa chạy M6/M7/runtime provider thật; browser sẽ dùng stack trộn và không chứng minh attendance đã ở Go. Chưa stage/commit/push, không nâng production-ready từ fixture local.

## Vòng sửa 1

Chỉ đổi test, tracker và report; không đổi runtime.

- I1: thêm `TestM5RootCommandsOnAnAbsentRequestAuditTheAbsentTarget` (`internal/app/m5_behavior_integration_test.go`): Root gửi decision rồi cancel tới `m1Absent`, assert 404 `error.notFound` và sau mỗi lệnh có thêm đúng một dòng `access.workRequest.read` với `principalKind=root`, `outcome=absent`, `key=m1Absent`. Dòng tracker `:38/:84` nay trỏ đúng symbol này.
- M1: hai submit membership đã kết thúc và team không tồn tại dùng `workday` (ngày sau `day`, thứ Ba làm việc) thay vì `day` là ngày lễ.
- M2: bỏ `len(httpapi.MigratedRoutes) != 65`; giữ kiểm hai chiều theo danh sách M5 tường minh (11 route).

RED qua overlay ngoài repo (/private/tmp/hrm-13d-mutants), không đột biến source thật:

| Mutant | Kết quả | Log |
| --- | --- | --- |
| fix1-decide: `Decide` trả not found trước `authority.Read` | exit 1: decision audits = 0, want 1 | hrm-13d-fix1-fix1-decide.log |
| fix1-cancel: `Cancel` tương tự | exit 1: cancel audits = 1, want 2 | hrm-13d-fix1-fix1-cancel.log |
| membership-ended (overlay có sẵn, `membership = "true"`) | exit 1 trên ngày làm việc: submit ended trả 201, còn kept 1 request | hrm-13d-fix1-membership-ended.log |
| guard-route (overlay có sẵn, bỏ route cancel khỏi MigratedRoutes) | exit 1: "M5 route is not migrated" | hrm-13d-fix1-guard-route.log |

GREEN focused ba test: exit 0, 8.444s (hrm-13d-fix1-green.log).

Gate (apps/api-go, GOCACHE=/private/tmp/hrm-go-cache, sau waitload): `go vet -tags integration ./...` exit 0 2s; `go test -race -tags integration -count=1 -p 1 ./internal/app` exit 0 57s (55.450s test); `go tool golangci-lint run` exit 0, 0 issues, 3s; `gofmt -l .` exit 0 rỗng; root `git diff --check` exit 0. Log: /private/tmp/hrm-13d-fix1-{vet,app,lint,gofmt}.log. Không chạy lại browser (chỉ đổi test).
