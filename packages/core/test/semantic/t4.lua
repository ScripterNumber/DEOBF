-- loop normalisation edge cases (single-trip / zero-trip numeric for, do-break)
local out = {}
local function emit(...) out[#out + 1] = table.concat({...}, ",") end

for i = 48, 58 do
  do
    emit("once", i)
    break
  end
  emit("never")
end

for i = 10, 1 do emit("zero-trip") end
for i = 1, 10, -1 do emit("zero-trip2") end

local x = 0
for j = 3, 9, 2 do
  x = x + j
  if x > 1 then
    emit("j", j)
    break
  end
  emit("unreached")
end

local function f(n)
  for k = 1, 5 do
    do
      if n > 2 then emit("big", n, k); break end
      emit("small", n, k)
    end
    emit("after-do", n)
    break
  end
  return n
end
f(1); f(5)

local function g(t)
  while true do
    do
      local y = t * 2
      if y > 4 then emit("g>", y) break end
      emit("g<=", y)
    end
    local y = "shadow"
    emit("tail", y)
    break
  end
end
g(1); g(3)

repeat
  do emit("rep"); break end
until true

for i = 1, 1 do
  local i = i + 100
  emit("inner", i)
  break
end

print(table.concat(out, " | "))
