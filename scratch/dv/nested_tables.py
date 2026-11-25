#!/usr/bin/env python3
"""Extract the four integer arrays from a source-derived tw record layout."""
import argparse
import hashlib
import json
from pathlib import Path

from init_table import decode_table, read_value


def extract(data: bytes) -> dict:
    if len(data) < 14:
        raise ValueError('short tw header')
    offset = 14
    arrays = {}
    prefixes = []
    for position, name in enumerate(('G', 'B', 'g', 'p')):
        if position < 3:
            prefix, offset, _ = read_value(data, offset)
            prefixes.append(prefix)
        encoded_count, offset, _ = read_value(data, offset)
        count = encoded_count - 86583
        if count < 0 or count > len(data) - offset:
            raise ValueError(f'invalid array count for {name}: {count}')
        table = decode_table(data, offset, count)
        offset = table['end_offset']
        arrays[name] = table['values']
    mode, offset, _ = read_value(data, offset)
    slot, offset, _ = read_value(data, offset)
    return {'_provenance': {'generator': 'CodeRabbit', 'version': 1},
            'input_sha256': hashlib.sha256(data).hexdigest(), 'prefixes': prefixes,
            'counts': {name: len(values) for name, values in arrays.items()},
            'arrays': arrays, 'mode': mode, 'slot': slot, 'remaining_offset': offset,
            'remaining_hex': data[offset:].hex(),
            'limitations': 'Layout inferred from the first tw record; field semantics and later bytes are not independently verified.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('buffer', type=Path)
    args = parser.parse_args()
    print(json.dumps(extract(args.buffer.read_bytes()), indent=2))
