#!/usr/bin/env python3
"""Validate the pinned AutobahnTestsuite index and every expected case record."""

import json
import pathlib
import sys

AGENT = "grpc-bridge-go-relay"
POLICY_BEHAVIORS = {
    "assert": ("OK", "OK"),
    "nonstrict-diagnostic": ("NON-STRICT", "OK"),
    "text-diagnostic": ("INFORMATIONAL", "INFORMATIONAL"),
    "informational-diagnostic": ("INFORMATIONAL", "INFORMATIONAL"),
}


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON member {key!r}")
        value[key] = item
    return value


def _read_json(path: pathlib.Path):
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_unique_object)


def validate_report(report_dir: pathlib.Path, expected_file: pathlib.Path) -> list[str]:
    """Return validation errors; an empty list means every expected case passed."""
    errors: list[str] = []
    try:
        expected = _read_json(expected_file)
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        return [f"expected-case list is missing or invalid: {exc}"]
    if (
        not isinstance(expected, dict)
        or not expected
        or any(not isinstance(case_id, str) for case_id in expected)
        or any(policy not in POLICY_BEHAVIORS for policy in expected.values())
    ):
        return ["expected-case policy must map case IDs to known policy names"]

    index_path = report_dir / "index.json"
    try:
        index = _read_json(index_path)
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        return [f"Autobahn index.json is missing or invalid under {report_dir}: {exc}"]
    if not isinstance(index, dict) or set(index) != {AGENT}:
        return [f"Autobahn index must contain exactly agent {AGENT!r}"]
    cases = index[AGENT]
    if not isinstance(cases, dict):
        return ["Autobahn agent report must map case IDs to case summaries"]

    actual = set(cases)
    expected_set = set(expected)
    if actual != expected_set:
        missing = sorted(expected_set - actual)
        unexpected = sorted(actual - expected_set)
        if missing:
            errors.append("missing expected Autobahn cases: " + ", ".join(missing))
        if unexpected:
            errors.append("unexpected Autobahn cases: " + ", ".join(unexpected))

    expected_files = {f"grpc_bridge_go_relay_case_{case_id.replace('.', '_')}.json" for case_id in expected}
    actual_files = {path.name for path in report_dir.glob("grpc_bridge_go_relay_case_*.json")}
    if actual_files != expected_files:
        missing = sorted(expected_files - actual_files)
        stale = sorted(actual_files - expected_files)
        if missing:
            errors.append("missing per-case report files: " + ", ".join(missing))
        if stale:
            errors.append("unexpected or stale per-case report files: " + ", ".join(stale))

    for case_id in sorted(expected_set & actual):
        summary = cases[case_id]
        if not isinstance(summary, dict):
            errors.append(f"case {case_id}: summary must be an object")
            continue
        expected_name = f"grpc_bridge_go_relay_case_{case_id.replace('.', '_')}.json"
        if summary.get("reportfile") != expected_name:
            errors.append(f"case {case_id}: missing or unexpected reportfile")
        behavior = summary.get("behavior")
        close_behavior = summary.get("behaviorClose")
        expected_behavior, expected_close = POLICY_BEHAVIORS[expected[case_id]]
        if behavior != expected_behavior:
            errors.append(f"case {case_id}: behavior is {behavior!r}, expected {expected_behavior!r}")
        if close_behavior != expected_close:
            errors.append(f"case {case_id}: behaviorClose is {close_behavior!r}, expected {expected_close!r}")

        case_path = report_dir / expected_name
        try:
            detail = _read_json(case_path)
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            errors.append(f"case {case_id}: detail report is missing or invalid: {exc}")
            continue
        if not isinstance(detail, dict):
            errors.append(f"case {case_id}: detail report must be an object")
            continue
        if detail.get("id") != case_id or detail.get("agent") != AGENT:
            errors.append(f"case {case_id}: detail identity does not match index")
        if detail.get("behavior") != behavior or detail.get("behaviorClose") != close_behavior:
            errors.append(f"case {case_id}: detail outcome does not match index")
        if not isinstance(detail.get("description"), str) or not detail["description"].strip():
            errors.append(f"case {case_id}: description is missing")
        if not isinstance(detail.get("result"), str) or not detail["result"].strip():
            errors.append(f"case {case_id}: result is missing")
    return errors


def main(report_dir: pathlib.Path, expected_file: pathlib.Path) -> int:
    errors = validate_report(report_dir, expected_file)
    if errors:
        for error in errors:
            print(f"Autobahn: {error}", file=sys.stderr)
        return 1
    expected = _read_json(expected_file)
    counts = {name: sum(policy == name for policy in expected.values()) for name in POLICY_BEHAVIORS}
    print(
        "Autobahn: "
        f"{counts['assert']} asserted cases passed; "
        f"{counts['nonstrict-diagnostic']} non-strict diagnostics; "
        f"{counts['text-diagnostic'] + counts['informational-diagnostic']} informational diagnostics; "
        f"reports retained in {report_dir}"
    )
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: check-autobahn-report.py REPORT_DIR EXPECTED_CASES.json", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])))
