import importlib.util
import json
import pathlib
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).with_name("check-autobahn-report.py")
SPEC = importlib.util.spec_from_file_location("check_autobahn_report", SCRIPT)
CHECKER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(CHECKER)


class AutobahnReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.report = self.root / "report"
        self.report.mkdir()
        self.expected = self.root / "expected.json"
        self.expected.write_text(json.dumps({"2.1": "assert"}), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def write_case(self, behavior="OK", close="OK"):
        filename = "grpc_bridge_go_relay_case_2_1.json"
        summary = {
            "behavior": behavior,
            "behaviorClose": close,
            "reportfile": filename,
        }
        (self.report / "index.json").write_text(
            json.dumps({"grpc-bridge-go-relay": {"2.1": summary}}), encoding="utf-8"
        )
        detail = {
            "agent": "grpc-bridge-go-relay",
            "id": "2.1",
            "behavior": behavior,
            "behaviorClose": close,
            "description": "Send ping without payload.",
            "result": "Actual events match at least one expected.",
        }
        (self.report / filename).write_text(json.dumps(detail), encoding="utf-8")

    def test_valid_pinned_index_and_case_report_pass(self):
        self.write_case()
        self.assertEqual(CHECKER.validate_report(self.report, self.expected), [])

    def test_empty_report_does_not_pass(self):
        (self.report / "index.json").write_text('{"grpc-bridge-go-relay": {}}', encoding="utf-8")
        self.assertTrue(CHECKER.validate_report(self.report, self.expected))

    def test_missing_report_fails(self):
        self.assertTrue(CHECKER.validate_report(self.report, self.expected))

    def test_missing_outcome_fails(self):
        self.write_case()
        index = json.loads((self.report / "index.json").read_text(encoding="utf-8"))
        del index["grpc-bridge-go-relay"]["2.1"]["behavior"]
        (self.report / "index.json").write_text(json.dumps(index), encoding="utf-8")
        self.assertTrue(CHECKER.validate_report(self.report, self.expected))

    def test_failing_behavior_or_close_fails(self):
        for behavior, close in (("FAILED", "OK"), ("OK", "WRONG CODE")):
            with self.subTest(behavior=behavior, close=close):
                self.write_case(behavior, close)
                self.assertTrue(CHECKER.validate_report(self.report, self.expected))

    def test_non_strict_diagnostic_has_exact_expected_outcome(self):
        self.expected.write_text(json.dumps({"2.1": "nonstrict-diagnostic"}), encoding="utf-8")
        self.write_case("NON-STRICT", "OK")
        self.assertEqual(CHECKER.validate_report(self.report, self.expected), [])
        self.write_case("OK", "OK")
        self.assertTrue(CHECKER.validate_report(self.report, self.expected))

    def test_informational_case_is_not_mistaken_for_assertion(self):
        self.expected.write_text(json.dumps({"2.1": "informational-diagnostic"}), encoding="utf-8")
        self.write_case("INFORMATIONAL", "INFORMATIONAL")
        self.assertEqual(CHECKER.validate_report(self.report, self.expected), [])

    def test_duplicate_json_members_fail(self):
        (self.report / "index.json").write_text(
            '{"grpc-bridge-go-relay":{"2.1":{"behavior":"OK","behavior":"FAILED"}}}',
            encoding="utf-8",
        )
        self.assertTrue(CHECKER.validate_report(self.report, self.expected))

    def test_stale_extra_case_file_fails(self):
        self.write_case()
        stale = self.report / "grpc_bridge_go_relay_case_99_1.json"
        stale.write_text("{}", encoding="utf-8")
        self.assertTrue(CHECKER.validate_report(self.report, self.expected))

    def test_missing_case_from_index_fails(self):
        self.write_case()
        (self.report / "index.json").write_text('{"grpc-bridge-go-relay": {}}', encoding="utf-8")
        self.assertTrue(CHECKER.validate_report(self.report, self.expected))


if __name__ == "__main__":
    unittest.main()
