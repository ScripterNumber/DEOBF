import unittest

from init_table import decode_table, read_value


class InitialTableTest(unittest.TestCase):
    def test_each_width_and_fourth_byte_high_bit(self):
        data = bytes.fromhex('7f f502 828119 81828304 81828384')
        result = decode_table(data, 0, 5)
        self.assertEqual(result['values'], [127, 14978, 16665, 2130435, 270565891])
        self.assertEqual(result['end_offset'], len(data))
        self.assertEqual(result['widths'], {1: 1, 2: 1, 3: 1, 4: 2})

    def test_truncated_and_invalid(self):
        for value in ('', '80', '8080', '808080'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                read_value(bytes.fromhex(value), 0)
        with self.assertRaises(ValueError):
            decode_table(b'', 0, -1)


if __name__ == '__main__':
    unittest.main()
