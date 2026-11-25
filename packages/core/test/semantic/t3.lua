-- break-to-else, switch-loop unrolling, while-true-once
local out = {}
local function emit(...) local t = { ... } for i = 1, select("#", ...) do t[i] = tostring(t[i]) end out[#out + 1] = table.concat(t, " ") end
for op = 0, 6 do
  repeat
    if op > 4 then emit("big", op) break end
    local t
    for k = 0, 1 do
      if 1 > k then t = op * 2 emit("first", t)
      elseif t > 6 then emit("second-hi", t)
      else emit("second-lo", t) end
    end
    if op == 2 then emit("two") break end
    emit("tail", op)
  until true
end
for step = 0, 6 do
  if step >= 3 then
    if step < 5 then
      if step == 4 then emit("s4") else emit("s3") end
    else
      if step == 5 then emit("s5") else emit("s6") end
    end
  else
    if step == 0 then emit("s0") elseif step == 1 then emit("s1") else emit("s2") end
  end
end
local x = 0
while true do
  x = x + 1
  if x > 0 then emit("once", x) break end
  emit("never")
  break
end
-- must not convert: loop continues
local y = 0
while y < 3 do y = y + 1 if y == 10 then break end end
emit("y", y)
-- scoping hazard: local in falling branch must not capture later name
local z = "outer"
repeat
  if #out > 1000 then break end
  do local z = "inner" end
  emit("z", z)
until true
print(table.concat(out, "\n"))
