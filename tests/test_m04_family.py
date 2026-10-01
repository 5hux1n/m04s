import asyncio
import json
import random
import struct
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from PIL import Image

from m04_family import (CONTINUOUS_TAIL, PROFILES, M04Codec, M04FamilyPrinter,
                        get_profile, validate_serial)
from m04s_codec import MiniLZO
from m04s_driver import M04Printer
from m04s_settings import PrintSettings
from m04s_status import StatusReplies

ROOT = Path(__file__).resolve().parents[1]


def quiet(*args, **kwargs):
    pass


class ProfileTests(unittest.TestCase):
    def test_profiles_match_recovered_sdk_and_ui(self):
        sdk = {p['model']: p for p in json.loads((ROOT / 'tests/fixtures/m04_profiles.json').read_text())}
        for name, profile in PROFILES.items():
            with self.subTest(model=name):
                self.assertEqual(profile.dpi, sdk[name]['dpi'])
                self.assertEqual(profile.max_content_dots, sdk[name]['maxPrintWidthInDot'])
                self.assertEqual(profile.serial_prefixes, tuple(p['sn'] for p in sdk[name]['snList']))
                self.assertEqual(sdk[name]['effectiveImageStrategy'], 'QYM04Strategy')
                self.assertEqual(profile.special_coefficient, sdk[name]['special_coefficient'])

    def test_serial_branches_and_missing_identity(self):
        for serial, encoding in [('Q016', 'minilzo'), ('Q171', 'raw'), ('Q466', 'raw'), ('Q999', 'minilzo')]:
            self.assertEqual(M04Codec('M04S', serial).encoding, encoding)
        with self.assertRaises(ValueError):
            M04Codec('M04S')
        for name in ('M04AS', 'M04AH', 'Y04S'):
            self.assertEqual(M04Codec(name).encoding, 'raw')
            with self.assertRaises(ValueError):
                M04Codec(name, encoding='minilzo')
        for name in ('M04ASH', 'M02', 'M03'):
            with self.assertRaises(ValueError):
                get_profile(name)
        for serial in ('q016', '', 'Q016\n', 'Q016' * 4):
            with self.assertRaises(ValueError):
                validate_serial(serial)

    def test_paper_dimensions_and_density_are_device_specific(self):
        self.assertEqual(PROFILES['M04AH'].content_width(53), 384)
        self.assertEqual(PROFILES['M04AS'].content_width(110), 1224)
        self.assertEqual(PROFILES['M04S'].content_width(110), 1248)
        for profile in PROFILES.values():
            for paper in profile.papers:
                width = profile.content_width(paper)
                self.assertEqual(width % 8, 0)
                self.assertLessEqual(width, profile.max_content_dots)
        self.assertEqual(PROFILES['M04AS'].settings(PrintSettings('special')).effective_coefficient, 100)
        self.assertEqual(PROFILES['M04S'].settings(PrintSettings('special')).effective_coefficient, 150)
        self.assertEqual(PROFILES['M04AS'].settings(PrintSettings('special', 120)).effective_coefficient, 120)
        with self.assertRaises(ValueError):
            PROFILES['M04AS'].settings(PrintSettings(paper='gap'))
        with self.assertRaises(ValueError):
            PROFILES['M04AH'].content_width(15)


class FamilyCodecTests(unittest.TestCase):
    def test_original_verified_bin_and_image_remain_identical(self):
        codec = M04Codec('M04S', 'Q016')
        original = (ROOT / 'samples/m04_printtask_1.bin').read_bytes()
        decoded = codec.parse(original)
        self.assertEqual(codec.build(decoded.raw, decoded.height, width=decoded.width).data, original)
        task = codec.image(ROOT / 'samples/66.png', width_dots=592)
        self.assertEqual(task.data, (ROOT / 'samples/m04_last_printtask.bin').read_bytes())

    def test_raw_branch_has_bitmap_and_no_compressed_sentinel(self):
        # Derive expected bitmap from the independent, already verified sample.
        original = MiniLZO().parse((ROOT / 'samples/m04_printtask_1.bin').read_bytes())
        for name, serial in [('M04S', 'Q171'), ('M04S', 'Q466'), ('M04AS', None), ('M04AH', None), ('Y04S', None)]:
            codec = M04Codec(name, serial)
            task = codec.build(original.raw, original.height, width=original.width)
            self.assertEqual(task.data[:8], original.data[:8])
            self.assertEqual(task.data[8:8 + len(original.raw)], original.raw)
            self.assertEqual(task.data[8 + len(original.raw):], CONTINUOUS_TAIL)
            self.assertEqual(codec.parse(task.data).raw, original.raw)
            for broken in (task.data[:-1], task.data[:8] + b'\0' + task.data[8:], original.data):
                with self.assertRaises(ValueError):
                    codec.parse(broken)

    def test_all_papers_roundtrip_and_preserve_image(self):
        for name, profile in PROFILES.items():
            serials = ('Q016', 'Q171', 'Q466') if name == 'M04S' else (None,)
            for serial in serials:
                codec = M04Codec(profile, serial)
                for paper in profile.papers:
                    with self.subTest(model=name, serial=serial, paper=paper):
                        task = codec.image(ROOT / 'samples/66.png', paper_mm=paper)
                        self.assertEqual(codec.parse(task.data).raw, task.raw)
                        preview = Image.frombytes('1', (task.width, task.height), bytes(b ^ 255 for b in task.raw))
                        if task.padding_left:
                            self.assertEqual(preview.crop((0, 0, task.padding_left, task.height)).getextrema(), (255, 255))
                        if task.padding_right:
                            self.assertEqual(preview.crop((task.width - task.padding_right, 0, task.width, task.height)).getextrema(), (255, 255))
        self.assertEqual(M04Codec('M04S', 'Q016').image(ROOT / 'samples/66.png').width, 592)
        self.assertEqual(M04Codec('M04S', 'Q171').image(ROOT / 'samples/66.png', paper_mm=80).width, 880)
        self.assertEqual(M04Codec('M04S', 'Q016').image(ROOT / 'samples/66.png', paper_mm=110).width, 1256)

    def test_limits_and_extended_margin(self):
        raw_codec = M04Codec('M04AH')
        raw = random.Random(3).randbytes(856 // 8 * 97)
        self.assertEqual(raw_codec.parse(raw_codec.build(raw, 97, width=856).data).raw, raw)
        for width in (863, 864, 0):
            with self.assertRaises(ValueError):
                raw_codec.build(b'', 1, width=width)
        codec = M04Codec('M04S', 'Q016')
        with self.assertRaises(ValueError):
            codec.build(b'\xff' * 157, 1, width=1256)
        self.assertEqual(M04Codec('M04AH').blank_feed(10).height, 80)
        self.assertEqual(codec.blank_feed(10).height, 118)
        with self.assertRaises(ValueError):
            codec.blank_feed(1e9)


class IdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_query_uses_official_request_and_response_opcodes(self):
        printer = M04FamilyPrinter('M04S', quiet)
        async def reply(command, *args):
            self.assertEqual(command, bytes.fromhex('1f 11 09'))
            printer._ff01(None, bytearray(b'\x1a\x08Q01612345678901'))
        printer.write = AsyncMock(side_effect=reply)
        result = await printer.get_status(('serial_number',))
        self.assertEqual(result['serial_number']['serial_number'], 'Q01612345678901')

    async def test_fragmented_serial_then_normal_status(self):
        parser = StatusReplies(quiet)
        future = parser.begin(0x08)
        frame = b'\x1a\x08Q01612345678901'
        for byte in frame[:-1]:
            parser.notify(bytes([byte]))
            self.assertFalse(future.done())
        parser.notify(frame[-1:] + b'\x1a\x04\x64\x1a\x0f\x0c')
        self.assertEqual((await future)['serial_number'], 'Q01612345678901')
        self.assertEqual(parser.latest['battery']['percent'], 100)
        self.assertEqual(parser.buffer, b'')

    async def test_invalid_serial_cannot_select_encoding(self):
        parser = StatusReplies(quiet)
        future = parser.begin(0x08)
        parser.notify(b'\x1a\x08' + bytes([255]) * 15)
        with self.assertRaises(ValueError):
            await future

    async def test_identity_read_before_format_selection_and_timeout(self):
        for serial in ('Q17112345678901', 'Q01612345678901'):
            printer = M04FamilyPrinter('M04S', quiet)
            printer.get_status = AsyncMock(return_value={'serial_number': {'serial_number': serial}})
            with patch.object(M04Printer, '__aenter__', AsyncMock()):
                await printer.__aenter__()
            self.assertEqual(printer.serial_number, serial)
        printer = M04FamilyPrinter('M04S', quiet)
        printer.get_status = AsyncMock(return_value={'serial_number': {'available': False}})
        with patch.object(M04Printer, '__aenter__', AsyncMock()), self.assertRaises(RuntimeError):
            await printer.__aenter__()

    async def test_wrong_model_or_encoding_does_not_write(self):
        printer = M04FamilyPrinter('M04S', quiet, serial_number='Q171')
        printer.write = AsyncMock()
        for task in (M04Codec('M04AS').build(bytes(74), 1), M04Codec('M04S', 'Q016').build(bytes(74), 1)):
            with self.assertRaises(ValueError):
                await printer.print_task(task, 'rejected')
        printer.write.assert_not_awaited()

    async def test_valid_task_delegates_to_shared_flow_with_model_settings(self):
        task = M04Codec('M04AS', 'Q089').build(bytes(74), 1)
        printer = M04FamilyPrinter('M04AS', quiet, serial_number='Q08912345678901')
        with patch.object(M04Printer, 'print_task', AsyncMock(return_value='completed')) as send:
            result = await printer.print_task(task, 'job', settings=PrintSettings('special'))
        self.assertEqual(result, 'completed')
        effective = send.call_args.args[3]
        self.assertEqual(effective.effective_coefficient, 100)
        self.assertEqual(effective.commands()[:2], [('initialize', b'\x1b@'), ('m04_mode', b'\x1f\x115\x01')])

    async def test_multiple_devices_stop_before_connecting(self):
        from types import SimpleNamespace
        devices = {n: (SimpleNamespace(address=n, name='M04AS'), SimpleNamespace(local_name='M04AS')) for n in ('a', 'b')}
        printer = M04FamilyPrinter('M04AS', quiet)
        with patch('m04s_driver.BleakScanner.discover', AsyncMock(return_value=devices)), \
             patch('m04s_driver.BleakClient') as client, self.assertRaises(RuntimeError):
            await printer.__aenter__()
        client.assert_not_called()

    async def test_exact_name_and_address_selection(self):
        printer = M04FamilyPrinter('M04AS', quiet, device_address='device-a')
        self.assertTrue(printer.matches_device('DEVICE-A', 'M04AS'))
        for address, name in [('device-b', 'M04AS'), ('device-a', 'M04S'), ('device-a', 'M04ASH')]:
            self.assertFalse(printer.matches_device(address, name))


if __name__ == '__main__':
    unittest.main()
