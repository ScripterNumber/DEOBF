-- guard / loop-once / dead-state tests (synthetic, mimics common obfuscator encodings)
local out = {}
local function emit(...) local t = { ... } for i = 1, select("#", ...) do t[i] = tostring(t[i]) end out[#out + 1] = table.concat(t, " ") end
for op = 0, 9 do
  local g = 10520635
  while op <= 4 do
    g -= g
    g = 3032872
    while 2 >= op do
      g -= g
      emit("low", op)
      break
    end
    while g / 1219 == 2488 do
      g = 8601846
      while op > 3 do g -= g emit("four", op) break end
      while g / 2209 == 3894 do emit("three", op) break end
      break
    end
    break
  end
  while g / 2195 == 4793 do
    g = 1
    emit("high", op)
    break
  end
end
-- break inside nested if binds to the while: must NOT be converted
local n = 0
while n < 10 do
  n = n + 1
  if n == 3 then break end
  if n > 100 then break end
end
emit("n", n)
-- repeat until true with inner loop breaks
repeat
  for i = 1, 3 do if i == 2 then break end emit("i", i) end
until true
-- captured variable must not be tracked
local cap = 1
local function bump() cap = cap + 1 end
bump()
if cap == 2 then emit("cap ok") else emit("cap BAD") end
-- loop-modified variable
local s = 0
for i = 1, 5 do s = s + i end
if s == 15 then emit("loop ok") end
-- self-only junk variable
local junk = 7
junk = junk * 3
junk -= junk
emit("done")
-- CFF state machine
local state = 3
local acc = {}
while state ~= 0 do
  if state == 3 then acc[#acc + 1] = "a" state = 7
  elseif state == 7 then acc[#acc + 1] = "b" state = (#acc > 5) and 0 or 9
  elseif state == 9 then acc[#acc + 1] = "c" state = 3
  end
end
emit(table.concat(acc))
print(table.concat(out, "\n"))
