import asyncio
import unittest
from m04s_settings import PrintSettings, auto_off_command
from m04s_status import StatusReplies, decode
from m04s_driver import M04Printer
from m04s_corebluetooth import HostGate
from m04s_codec import MiniLZO, WIDTH_BYTES


def quiet(*args, **kwargs):
    pass


class SettingsTests(unittest.TestCase):
    def test_blank_feed_is_white_and_bad_lengths_fail_before_connect(self):
        codec=MiniLZO()
        task=codec.blank_feed(10)
        self.assertEqual(task.height,118)
        self.assertEqual(task.raw,bytes(118*WIDTH_BYTES))
        for value in [-1,0,float('nan'),float('inf'),10000]:
            with self.subTest(value=value),self.assertRaises(ValueError):
                codec.blank_feed(value)
    def test_special_then_normal_resets_coefficient(self):
        special = dict(PrintSettings('special').commands())
        normal = dict(PrintSettings('medium').commands())
        self.assertEqual(special['density'], bytes.fromhex('1f 11 02 04'))
        self.assertEqual(special['coefficient'], bytes.fromhex('1f 11 37 96'))
        self.assertEqual(normal['coefficient'], bytes.fromhex('1f 11 37 64'))
        self.assertNotIn('speed', normal)
        self.assertNotIn('paper', normal)

    def test_speed_is_last_and_explicitly_unverified(self):
        settings=PrintSettings('medium',speed=5)
        self.assertEqual(settings.commands()[-1],('speed',bytes.fromhex('1f 11 23 05')))
        self.assertEqual(settings.describe()['speed_support'],'unverified')

    def test_invalid_values_cannot_wrap_to_other_control_bytes(self):
        for value in [-1,0,256,1.5,True]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                PrintSettings(coefficient=value)
            with self.subTest(speed=value), self.assertRaises(ValueError):
                PrintSettings(speed=value)
        for minutes in [-5,3,1280,True]:
            with self.subTest(minutes=minutes),self.assertRaises(ValueError):
                auto_off_command(minutes)
        self.assertEqual(auto_off_command(10),bytes.fromhex('1b 4e 07 02'))
        self.assertEqual(auto_off_command(0),bytes.fromhex('1b 4e 07 00'))

    def test_status_unknown_does_not_report_healthy(self):
        self.assertIsNone(decode(bytes.fromhex('1a 05 00'))['open'])
        self.assertIsNone(decode(bytes.fromhex('1a 06 00'))['present'])
        self.assertEqual(decode(bytes.fromhex('1a 03 00'))['state'],'unknown')
        self.assertIsNone(decode(bytes.fromhex('1a 04 a1'))['percent'])


class StatusTests(unittest.IsolatedAsyncioTestCase):
    async def test_fragmented_combined_responses_match_correct_query(self):
        status=StatusReplies(quiet)
        cover=status.begin(5)
        paper=status.begin(6)
        status.notify(bytes.fromhex('1a 04 1e 1a 05'))
        self.assertFalse(cover.done())
        status.notify(bytes.fromhex('98 1a 0f 0c 1a 06 89'))
        self.assertFalse((await cover)['open'])
        self.assertTrue((await paper)['present'])
        self.assertEqual(status.latest['battery']['percent'],30)
        mode=status.begin(0x0c)
        status.notify(bytes.fromhex('1a 0c 0b'))
        self.assertEqual((await mode)['mode'],'continuous')

    async def test_old_snapshot_does_not_satisfy_new_query(self):
        status=StatusReplies(quiet)
        status.notify(bytes.fromhex('1a 09 02'))
        future=status.begin(9)
        self.assertFalse(future.done())
        status.notify(bytes.fromhex('1a 09 03'))
        self.assertEqual((await future)['minutes'],15)

    async def test_query_disconnect_is_not_a_response_timeout(self):
        status=StatusReplies(quiet)
        future=status.begin(4)
        status.fail('disconnected')
        with self.assertRaises(ConnectionError):
            await future

    async def test_control_write_uses_credit_and_host_gate(self):
        printer=M04Printer(quiet)
        printer.credit.notify(bytes.fromhex('01 07'))
        printer.credit.notify(bytes.fromhex('02 f4 00'))
        writes=[]
        class Client:
            is_connected=True
            async def write_gatt_char(self,uuid,data,response):
                writes.append(bytes(data))
                printer.credit.notify(bytes.fromhex('01 01'))
        printer.client=Client()
        printer.gate=HostGate(lambda:True,lambda:True,quiet)
        for index,(name,command) in enumerate(PrintSettings('special',speed=5).commands(),1):
            await printer.write(command,'SETTING_'+name.upper(),index,3)
        self.assertEqual(printer.credit.available,7)
        self.assertEqual(printer.credit.overflow,0)
        self.assertEqual(printer.credit.writes,3)
        self.assertEqual(printer.gate.checks,3)
        self.assertEqual(printer.completion.sent_bytes,0)
        self.assertEqual(writes[1],bytes.fromhex('1f 11 37 96'))

if __name__=='__main__':unittest.main()
