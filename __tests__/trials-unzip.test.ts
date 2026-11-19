import zlib from "zlib";

/** The trial runner's unzip (scripts/trials/unzip.js) on archives built here. */

const { unzip } = require("../scripts/trials/unzip.js") as {
  unzip: (b: Buffer) => Map<string, Buffer>;
};

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** A one-entry zip archive, stored (0) or deflated (8). */
function archive(name: string, data: Buffer, method: 0 | 8): Buffer {
  const body = method === 8 ? zlib.deflateRawSync(data) : data;
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const dirAt = local.length + n.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + n.length, 12);
  end.writeUInt32LE(dirAt, 16);
  return Buffer.concat([local, n, body, central, n, end]);
}

describe("trial unzip", () => {
  const data = Buffer.from("ENC cell bytes ".repeat(40));

  test("stored and deflated entries come back as they went in", () => {
    for (const method of [0, 8] as const) {
      expect(
        unzip(archive("ENC_ROOT/US5X/US5X.000", data, method)).get("ENC_ROOT/US5X/US5X.000")
      ).toEqual(data);
    }
  });

  test("an entry whose bytes changed is rejected, not returned", () => {
    const zip = archive("US5X.000", data, 0);
    const at = 30 + "US5X.000".length + 3;
    zip.writeUInt8((zip.readUInt8(at) ^ 0xff) & 0xff, at);
    expect(() => unzip(zip)).toThrow(/CRC/);
  });
});
