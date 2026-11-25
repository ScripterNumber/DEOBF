local function f(a)
  local out = {}
  local V = 10
  while true do
    if V == 10 then
      out[1] = a
      V = 20
    elseif V == 20 then
      if a > 3 then V = 30 else V = 40 end
    elseif V == 30 then
      out[2] = "big"
      V = 50
    elseif V == 40 then
      out[2] = "small"
      V = 50
    elseif V == 50 then
      out[3] = #out
      break
    elseif V == 99 then
      out[9] = "junk"
      V = 10
    end
  end
  return out
end
local function g(n)
  local s, i = 0, 1
  local st = 7
  repeat
    if st < 8 then
      if st == 7 then
        st = (i <= n) and 9 or 11
      end
    elseif st == 9 then
      s = s + i
      i = i + 1
      st = 7
    else
      st = 12
      break
    end
  until false
  return s
end
local function h(x)
  local V = 5
  while V do
    if V == 5 then x = x * 2; V = -3
    elseif V == -3 then x = x + 1; V = nil end
  end
  return x
end
local r = f(5); print(r[1], r[2], r[3]); r = f(1); print(r[1], r[2], r[3])
print(g(10), g(0), h(4))
