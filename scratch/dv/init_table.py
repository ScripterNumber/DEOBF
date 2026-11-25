#!/usr/bin/env python3
"""Decode the initial bw table as data; this is not a Lua or VM interpreter."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path


def read_value(data: bytes, offset: int) -> tuple[int, int, int]:
    """Apply the one-to-four byte branches of bw's Cw/gw/xw/dw/zw/pw path."""
    if not 0 <= offset < len(data):
        raise ValueError(f'out of data at {offset}')

    def byte() -> int:
        nonlocal offset
        if offset >= len(data):
            raise ValueError(f'truncated value at {offset}')
        result = data[offset]
        offset += 1
        return result

    a = byte()
    if a < 128:
        return a, offset, 1
    b = byte()
    if b < 128:
        return (a - 128) * 128 + b, offset, 2
    c = byte()
    if c < 128:
        return (a - 128) * 128 + (b - 128) * 16384 + c, offset, 3
    d = byte()
    return ((a - 128) * 2097152 + (b - 128) * 16384 + (c - 128)
            + (d % 128) * 128 + (d - d % 128) * 2097152), offset, 4


def decode_table(data: bytes, offset: int, count: int) -> dict:
    if offset < 0 or offset > len(data) or count < 0:
        raise ValueError('invalid offset or count')
    start = offset
    widths: Counter[int] = Counter()
    values = []
    for _ in range(count):
        value, offset, width = read_value(data, offset)
        values.append(value)
        widths[width] += 1
    return {'_provenance': {'generator': 'CodeRabbit', 'version': 1},
            'input_sha256': hashlib.sha256(data).hexdigest(), 'offset': start,
            'count': count, 'end_offset': offset,
            'widths': dict(sorted(widths.items())), 'values': values}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('buffer', type=Path, help='literal bytes extracted from the wrapper')
    parser.add_argument('--offset', type=int, required=True)
    parser.add_argument('--count', type=int, required=True)
    args = parser.parse_args()
    print(json.dumps(decode_table(args.buffer.read_bytes(), args.offset, args.count), indent=2))
