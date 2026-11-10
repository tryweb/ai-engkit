## Purpose

Adds optional lean-ctx Decision Loop summary metrics to the Admin Dashboard, alongside the dashboard's other operational information, so an administrator can monitor high-level value and savings signals without requiring the dashboard to be a full LeanCTX analytics view.

## Requirements

### Requirement: Dashboard displays Decision Loop summary metrics
The Admin Dashboard SHALL present Decision Loop data inside the single `LeanCTX Insights` section under the `Decision Quality` label. It SHALL show total tasks assessed, acceptance rate, CPAO in USD, and ETPAO in tokens, and SHALL NOT repeat estimated USD savings already represented by the Dashboard savings hierarchy or show per-task details. When the value-report probe fails or returns no data, only the Decision Quality subsection SHALL render its unavailable or empty state.

#### Scenario: Value report data renders successfully
- **WHEN** the `value-report --live --format json` probe succeeds and returns task data
- **THEN** Decision Quality shows tasks assessed, acceptance rate, CPAO, and ETPAO within LeanCTX Insights

#### Scenario: Value report probe fails
- **WHEN** the value-report probe times out, returns non-JSON, or the command is unavailable
- **THEN** Decision Quality displays `Data unavailable` and the Dashboard and other Insights subsections still render

#### Scenario: Value report returns empty data
- **WHEN** the value-report probe succeeds but reports zero tasks assessed
- **THEN** Decision Quality displays `No assessments recorded yet`

### Requirement: Dashboard displays signed savings-ledger evidence
The Admin Dashboard SHALL present signed savings-ledger proof inside the single `LeanCTX Insights` section under the `Evidence` label using the supported `roi --json` report. It SHALL show signature status, chain validity, and event count without implying task-level proof or evidence-chain completeness.

#### Scenario: ROI report data renders successfully
- **WHEN** the `roi --json` probe succeeds
- **THEN** Evidence shows whether the report is signed, whether its hash chain is valid, and the ledger event count

#### Scenario: ROI probe fails
- **WHEN** the ROI probe times out, returns non-JSON, or the command is unavailable
- **THEN** Evidence displays `Data unavailable` and the other Insights subsections still render

### Requirement: Dashboard displays a savings-by-tool summary
The Admin Dashboard SHALL present up to five top tools inside the single `LeanCTX Insights` section under the `Top Saving Tools` label. It SHALL identify the savings period from the report. Tools SHALL be ordered by tokens saved descending and each entry SHALL show tool name, tokens saved, and derived share using a compact proportional bar. Net tokens saved, net USD saved, and compression percentage SHALL remain owned by the KPI card and SHALL NOT be repeated in LeanCTX Insights.

#### Scenario: Savings report data renders successfully
- **WHEN** the `savings --format json` probe succeeds with more than five sources
- **THEN** Top Saving Tools shows the five largest sources in descending token order with token and share values

#### Scenario: Savings report probe fails
- **WHEN** the savings-report probe times out, returns non-JSON, or the command is unavailable
- **THEN** Top Saving Tools displays `Data unavailable` and the other Insights subsections still render

#### Scenario: Savings report is empty
- **WHEN** the savings-report probe succeeds with no top sources
- **THEN** Top Saving Tools displays `No savings data`

### Requirement: LeanCTX Insights uses fixed order and deterministic formatting
LeanCTX Insights SHALL render its subsections in this fixed order: `Savings Economics`, `Decision Quality`, `Evidence`, then `Top Saving Tools`. Integer counts and token values SHALL use `en-US` grouping with no decimal places; percentages SHALL use one decimal place followed by `%`; USD values SHALL use `$` and exactly two decimal places; CPAO SHALL be converted from micros to USD and shown with four decimal places; and ETPAO SHALL use a grouped integer followed by ` tokens`.

#### Scenario: Insights renders complete data
- **WHEN** all four Insights data sources succeed
- **THEN** the four subsections appear in the required order and their values use the required formatting

### Requirement: LeanCTX Insights explains savings without repeating KPI headlines
LeanCTX Insights SHALL include a `Savings Economics` subsection showing gross USD and gross tokens saved, stream-overhead USD and bounce tokens, and ledger verification status. It SHALL omit net tokens saved, net USD saved, compression percentage, memory fact totals, project activity totals, and project health coverage because those values are owned by the KPI row. The Projects card SHALL contain project-management information and SHALL NOT repeat LeanCTX memory or activity aggregates.

#### Scenario: Gain detail is available
- **WHEN** gain telemetry succeeds
- **THEN** Savings Economics shows gross savings, stream overhead, and ledger verification without repeating the KPI headline values

#### Scenario: Project summary renders
- **WHEN** LeanCTX site statistics are available
- **THEN** the Projects card does not render total facts, active projects, health coverage, or projects-with-facts rows

#### Scenario: Gain detail is unavailable
- **WHEN** the gain probe fails, times out, or returns invalid data
- **THEN** Savings Economics displays `Data unavailable` and the other Insights subsections still render

#### Scenario: Gain detail contains zero values
- **WHEN** the gain probe succeeds with zero gross savings, zero overhead, and zero ledger events
- **THEN** Savings Economics displays the formatted zero values rather than an empty-state message
