# TX/RX transition review (v141)

Three independent review lanes covered slotted modes, picture/text modes, and
CW/voice, with a separate check of microphone ingress and the native driver's
timeout contract. Baseline: `a23ba60`. No physical RF was used.

## Native LAN fixes in PR #74

| Confirmed defect | Fix and evidence |
|---|---|
| RTTY cleanup could interleave a newer key preparation in the same association, leaving the newer transmission in FSK RTTY mode | Restore settings as one native driver settings transaction, with the original session and PTT revision checked at entry. A real localhost peer now remains in USB/DATA with LAN modulation for the newer transmission. Picture-mode restoration has the same transaction boundary. |
| A TTY setup aborted before keying could release another producer | Track the native key attempt and avoid sending an unrelated OFF. USB retains its existing force-OFF behavior. |
| SSTV, EasyPal and TTY treated native `drain(false)` cancellation as successful delivery | Report aborted rather than sent. |
| Late or unrelated microphone packets could contaminate a native modem transmission; malformed PCM could trigger its PTT release | Accept native microphone packets only from the current or pending browser PTT owner. Server-generated modem audio remains independent. Owner audio still queues during key preparation; late packets during/after release are excluded. |

Native restoration also requires confirmed cached receive state before changing
routing or power. The generic USB cleanup behavior is retained; its shared
failure-path problem is reported upstream below.

The LAN test runner executes test files serially: these fault tests deliberately
use short CI-V deadlines and start native workers, so unrelated parallel startup
load should not manufacture link failures.

## Original upstream defects reported separately

Original bridge classes from upstream `da2d962` were loaded unchanged into the
localhost fault tests. Nine safety assertions failed as expected, confirming
that these defects are not introduced by the LAN implementation.

| Upstream report | Finding and suggested direction |
|---|---|
| [#75](https://github.com/StevPem/piro/issues/75) | SSTV/EasyPal/RTTY can restore DATA, mode, frequency or power after rejected PTT-off. Defer restoration until release is confirmed. |
| [#76](https://github.com/StevPem/piro/issues/76) | JS8 reports released/completed after PTT-off rejection. Propagate failure and preserve retryable Stop and honest keyed state. |
| [#77](https://github.com/StevPem/piro/issues/77) | WSPR can restore high power while keyed or resume local RX after rejected release. Await TX completion, serialize restoration with new keying, and require confirmed receive. |
| [#78](https://github.com/StevPem/piro/issues/78) | CW treats failed state reads or expiry of its receive-confirmation deadline as success. Require confirmed quiet RX or stop/report an error. |
| [#79](https://github.com/StevPem/piro/issues/79) | CW abort during a pending mode read still changes keyer settings. Check cancellation after setup awaits and before new mutations. |

CW, JS8 and WSPR source is unchanged by this follow-up. Candidate fixes and
reproductions for upstream issues are retained locally, outside the PR. These
reported error paths remain unresolved here pending separate upstream work.

## Checked without another confirmed defect

- FT8/FT4 reject failed release; the production last-browser cancellation hook
  prevents stale audio after pending native keying.
- Voice/RADE already guard stale pipeline output/errors and retain mic muting
  until confirmed release. Microphone ingress is tightened as described above.
- Missing native PTT-on acknowledgement resets the association, retains routing
  records, and restores them only after reconnect confirms receive. The initial
  suspected unsafe native rollback was not a defect.
- An initial CW cross-generation concern was not substantiated with realistic
  production timing; it is not claimed as an additional finding.

The tests exercise software state, command ordering, fault handling and local
UDP transport. They do not certify RF quality or physical failure recovery.

## Validation

- Raspberry Pi, Node 22.23.4: `TEST_RETRIES=0 npm run test:ci` passed
  **65/65 test groups** in 414 seconds, including **191 LAN checks**.
- The final focused native transition/ownership tests passed **24/24** on the
  Pi and locally. Existing TTY, SSTV, EasyPal and WebSocket suites also passed.
- Syntax, diff and build-version checks passed; no dependencies changed.
- The live service was left on v140. This v141 follow-up updates PR #74 only.
