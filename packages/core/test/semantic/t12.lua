-- for-loop style dispatchers (counter stepped at the loop head), condition temporaries,
-- unreachable code after returns inside closures
local out = {}
local function log(...) local t = table.pack(...) for i = 1, t.n do out[#out + 1] = tostring(t[i]) end end

local function disp(a, f)
  local i, c, t = 85, nil, nil
  while true do
    i = i + 18
    t = i <= 167
    if t then
      if i == 121 then
        c = f(a)
        if not not c then
          i = 72
          while true do
            i = i + 44
            t = i <= 167
            if t then
              if not not (i <= 116) then log("inner", i); continue else log("call", i); break end
            else break end
          end
          do return c end
          log("dead")
        else
          do return "none" end
          log("dead2")
        end
      elseif i == 103 then
        log("first", i)
        continue
      else
        log("other", i)
        continue
      end
    else
      break
    end
  end
  return "fell"
end
log(disp(3, function(x) return x * 2 end))
log(disp(4, function(x) return nil end))

-- counter loop with a fall-through end and a compound update
local function count(n)
  local k, acc = 0, {}
  while true do
    k += 3
    if k > n then break end
    if k == 6 then acc[#acc + 1] = "six" else acc[#acc + 1] = k end
  end
  return table.concat(acc, " ")
end
log(count(14), count(2))

-- a closure with dead code after its return
local mk = function(v)
  return function()
    do return v + 1 end
    v = v + 100
  end
end
log(mk(1)(), mk(41)())
print(table.concat(out, ","))
