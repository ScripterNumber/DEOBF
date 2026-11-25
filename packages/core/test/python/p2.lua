-- deserializer-style code: byte reader with upvalue position, varint, floats, nested tables
local data = "\5\0\0\0hello\2\1\42\3\255\255\255\255\4\0\0\0\0\0\0\240\63"
local pos = 1
local function u8()
  local b = data:byte(pos)
  pos = pos + 1
  return b
end
local function u32()
  local a, b, c, d = data:byte(pos, pos + 3)
  pos = pos + 4
  return a + b * 256 + c * 65536 + d * 16777216
end
local function str()
  local n = u32()
  local s = data:sub(pos, pos + n - 1)
  pos = pos + n
  return s
end
local function f64()
  local lo, hi = u32(), u32()
  local sign = hi >= 2 ^ 31 and -1 or 1
  local e = math.floor(hi / 2 ^ 20) % 2048
  local m = (hi % 2 ^ 20) * 2 ^ 32 + lo
  if e == 0 then return sign * m * 2 ^ -1074 end
  return sign * (1 + m / 2 ^ 52) * 2 ^ (e - 1023)
end
local consts = {}
consts[1] = str()
local tag = u8()
while tag do
  if tag == 2 then consts[#consts + 1] = u8() == 1
  elseif tag == 3 then consts[#consts + 1] = u32()
  elseif tag == 4 then consts[#consts + 1] = f64()
  elseif tag == 1 then consts[#consts + 1] = u8()
  end
  if pos > #data then break end
  tag = u8()
end
for i, v in ipairs(consts) do print(i, type(v), tostring(v)) end
-- closures capturing loop variables & nested upvalue writes
local fns = {}
for i = 1, 3 do fns[i] = function() return i * 10 end end
print(fns[1](), fns[2](), fns[3]())
local function outer()
  local n = 0
  local function bump(k) n = n + k end
  local function get() return n end
  bump(2); bump(5)
  return get
end
print(outer()())
-- repeat/until with local in condition, numeric for with float step, goto-free continue
local i = 0
repeat local j = i * 2; i = i + 1 until j >= 6
print(i)
local acc = {}
for x = 0, 1, 0.25 do acc[#acc + 1] = x end
print(table.concat(acc, " "))
-- string building / escapes / bytes > 127
local bytes = {}
for b = 250, 255 do bytes[#bytes + 1] = string.char(b) end
local s = table.concat(bytes)
print(#s, s:byte(1), s:byte(-1), ("%q"):format("a\nb"))
-- table sort / unpack / select negative
local t = { 5, 3, 9, 1 }
table.sort(t)
print(table.concat(t, ","), select(-1, 1, 2, 3), (table.unpack or unpack)({ 1, 2, 3 }))
table.sort(t, function(a, b) return a > b end)
print(table.concat(t, ","))
-- integer division / modulo of negatives / huge numbers
print(-7 // 2, -7 % 2, 7 % -2, 2 ^ 53 + 1, math.huge, -math.huge, 1e300 * 1e10)
print(math.max(3, 9, 2), math.min(3, 9, 2), math.abs(-4), math.floor(-3.5), math.ceil(-3.5), math.fmod(-7, 2))
print(string.rep("ab", 3), ("x"):len(), #"", tostring(1e15), tostring(123456789012), tostring(0.1 + 0.2))
-- Luau continue inside repeat-until evaluates the condition
local k, seen = 0, {}
repeat
  k = k + 1
  if k % 2 == 0 then continue end
  seen[#seen + 1] = k
  if k > 50 then break end
until k >= 7
print(k, table.concat(seen, ","))
local w = 0
while w < 5 do w += 1; if w == 2 then continue end end
print(w)
