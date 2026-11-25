--[==[
  PRISM — Luarmor / Luraph payload extractor (Luau, Roblox executor)

  Никакой песочницы и никакого env: скрипт работает в твоём обычном окружении
  исполнителя. Он только перехватывает loadstring/load, поэтому видит каждый чанк,
  который цепочка передаёт дальше, и сохраняет их файлами.

  Использование (любой из вариантов):
      getgenv().PRISM_EXTRACT_URL = "https://api.luarmor.net/files/v4/loaders/<hash>.lua"
      loadstring(readfile("luarmor_extract.lua"))()

      -- либо из файла, который уже скачал curl'ом:
      getgenv().PRISM_EXTRACT_FILE = "loader.lua"

      -- либо прямой защищённый скрипт (superflow) + его _bsdata0:
      getgenv().PRISM_EXTRACT_URL = "https://.../protected.lua"
      getgenv().PRISM_EXTRACT_BSDATA = [[{4182313029,64563650,...}]]

  Что появится в папке (по умолчанию prism_extract):
      00_loader.lua          исходник загрузчика
      00_bsdata0.txt         статически вырезанный литерал _bsdata0 (если найден)
      00_init.lua            init с cdn.luarmor.net
      NN_<kind>_<bytes>.lua  каждый перехваченный чанк: stage / luraph / bytecode
      manifest.txt           сводка

  Лураф-пейлоад НЕ исполняется: он сохраняется, и хуком возвращается пустышка,
  чтобы антитампер внутри него не успел сработать. Включается через
  getgenv().PRISM_EXTRACT_RUN_PAYLOAD = true.
]==]

-- --------------------------------------------------------------------- config
local genv = (type(getgenv) == "function" and getgenv()) or _G

local CONFIG = {
	url = genv.PRISM_EXTRACT_URL
		or "https://api.luarmor.net/files/v4/loaders/5857a6cfae3b902eb3c2dff7cdbf173b.lua",
	file = genv.PRISM_EXTRACT_FILE,
	bsdata = genv.PRISM_EXTRACT_BSDATA,
	outDir = genv.PRISM_EXTRACT_OUT or "prism_extract",
	maxChunks = genv.PRISM_EXTRACT_MAX_STAGES or 12,
	-- лураф-пейлоад надо ИСПОЛНИТЬ: он сам распаковывает байткод в Lua-чанк "Luraph"
	runPayload = genv.PRISM_EXTRACT_RUN_PAYLOAD ~= false,
	-- а вот уже распакованный чанк исполнять не нужно: он и есть цель
	runFinal = genv.PRISM_EXTRACT_RUN_FINAL == true,
	-- собрать самодостаточный bundle.lua (без Luarmor и без сети)
	bundle = genv.PRISM_EXTRACT_BUNDLE ~= false,
	-- форматтер 3 МБ посимвольно — дорого; включается вручную
	pretty = genv.PRISM_EXTRACT_PRETTY == true,
	-- запускать цепочку, даже если бандл уже собран из пейлоада на диске
	chain = genv.PRISM_EXTRACT_CHAIN == true,
	-- дампить аргументы, с которыми stage вызывает пейлоад (данные байткода)
	dumpArgs = genv.PRISM_EXTRACT_ARGS ~= false,
	userAgent = "Roblox/WinInet",
}

-- ---------------------------------------------------------------- io / helpers
local function out(...)
	local parts = {}
	for i = 1, select("#", ...) do
		parts[#parts + 1] = tostring(select(i, ...))
	end
	pcall(print, "[PRISM] " .. table.concat(parts, " "))
end

local function ensureFolder(path)
	if type(makefolder) == "function" and type(isfolder) == "function" then
		local ok, exists = pcall(isfolder, path)
		if not (ok and exists) then
			pcall(makefolder, path)
		end
	elseif type(makefolder) == "function" then
		pcall(makefolder, path)
	end
end

local function writeOut(name, data)
	local path = CONFIG.outDir .. "/" .. name
	if type(writefile) ~= "function" then
		out("no writefile in this executor, cannot save", name)
		return nil
	end
	local ok, err = pcall(writefile, path, data)
	if not ok then
		out("write failed", path, err)
		return nil
	end
	return path
end

local function readIn(name)
	if type(readfile) ~= "function" then return nil end
	local ok, data = pcall(readfile, name)
	if ok and type(data) == "string" and #data > 0 then return data end
	return nil
end

local function head(s, n)
	s = tostring(s or "")
	n = n or 90
	s = s:sub(1, n)
	return (s:gsub("[%c]", function(c)
		if c == "\n" then return "\\n" end
		if c == "\r" then return "\\r" end
		if c == "\t" then return "\\t" end
		return "?"
	end))
end

-- ------------------------------------------------------------------- downloading
local function tryTransport(label, fn)
	local ok, res = pcall(fn)
	if not ok then
		out("http", label, "err:", tostring(res):sub(1, 120))
		return nil
	end
	if type(res) == "string" then
		if #res > 0 then
			out("http", label, "ok", #res .. "B")
			return res
		end
		out("http", label, "empty")
		return nil
	end
	if type(res) == "table" then
		local body = res.Body or res.body or res.Data or res.data or res.Content
		if type(body) == "string" and #body > 0 then
			out("http", label, "ok", #body .. "B")
			return body
		end
		out("http", label, "table, status", tostring(res.StatusCode or res.status))
		return nil
	end
	out("http", label, "returned", type(res))
	return nil
end

local function spec(u)
	return {
		Url = u, url = u, Method = "GET",
		Headers = { ["User-Agent"] = CONFIG.userAgent, ["user-agent"] = CONFIG.userAgent },
	}
end

local function httpGet(u)
	out("fetch", u)
	local candidates = {
		{ "request", request },
		{ "http_request", http_request },
		{ "http.request", type(http) == "table" and http.request or nil },
		{ "syn.request", type(syn) == "table" and syn.request or nil },
	}
	for _, c in ipairs(candidates) do
		if type(c[2]) == "function" then
			local body = tryTransport(c[1], function() return c[2](spec(u)) end)
			if body then return body end
		end
	end
	local gm = game
	if gm then
		for _, name in ipairs({ "HttpGet", "HttpGetAsync" }) do
			local fn = gm[name]
			if type(fn) == "function" then
				local body = tryTransport("game:" .. name, function() return fn(gm, u) end)
				if body then return body end
				body = tryTransport("game:" .. name .. "(plain)", function() return fn(u) end)
				if body then return body end
			end
		end
	end
	out("all transports failed for", u)
	return nil
end

-- --------------------------------------------------------------- classification
local function classify(src)
	if src:find("RP=bit32", 1, true) or src:find("Luraph", 1, true) then return "luraph" end
	if src:find("superflow_bytecode", 1, true) then return "stage" end
	if src:find("v4_init", 1, true) then return "init" end
	if src:find("_bsdata0", 1, true) then return "loader" end
	if #src > 50000 then return "bytecode" end
	return "chunk"
end

-- вырезать литерал `_bsdata0={...}` с учётом строк и вложенности
local function extractBsdata(src)
	local at = src:find("_bsdata0%s*=%s*{")
	if not at then return nil end
	local start = src:find("{", at)
	local depth, i, n = 0, start, #src
	while i <= n do
		local c = src:sub(i, i)
		if c == '"' or c == "'" then
			local q = c
			i = i + 1
			while i <= n do
				local d = src:sub(i, i)
				if d == "\\" then i = i + 2
				elseif d == q then break
				else i = i + 1 end
			end
			i = i + 1
		elseif c == "{" then
			depth = depth + 1
			i = i + 1
		elseif c == "}" then
			depth = depth - 1
			if depth == 0 then
				return src:sub(start, i)
			end
			i = i + 1
		else
			i = i + 1
		end
	end
	return nil
end

-- -------------------------------------------------------------------- capturing
local ORIG_LS = loadstring or load
local ORIG_LOAD = load
if type(ORIG_LS) ~= "function" then
	error("[PRISM] this executor has neither loadstring nor load")
end

local captures = {}
local depth = 0
local stopped = false

-- Похоже ли на нормальный Lua, а не на сгенерированную VM-простыню:
-- нет таблиц с числовыми ключами вида [120]= и есть осмысленные имена функций.
local function looksReadable(src)
	local sample = src:sub(1, 262144)
	if sample:find("%[%d+%]%s*=") then return false end
	local named = 0
	for call in sample:gmatch("[%a_][%w_]*%s*%(") do
		local name = call:match("^(.-)%s*%(")
		if name and #name > 4 and not name:match("^[0-9]") then
			named = named + 1
			if named >= 6 then return true end
		end
	end
	return false
end

-- Явное имя чанка от самой цепочки (не наше служебное =layerN) — это уже
-- результат распаковки: Luraph, LPH, VM, decompressed и т.п.
local function isProduced(chunkname)
	if type(chunkname) ~= "string" or chunkname == "" then return false end
	if chunkname:match("^=layer%d+$") then return false end
	if chunkname:match("[Ll]uraph") or chunkname:match("LPH") then return true end
	if chunkname:match("[Dd]ecompress") or chunkname:match("^=?[Vv][Mm]$") then return true end
	return false
end

-- Мягкий форматтер: бьёт однострочный вывод распаковщика на строки по ; и
-- ключевым словам, не заходя внутрь строк, длинных скобок и комментариев.
local function pretty(src)
	if #src > 12 * 1024 * 1024 then return nil end
	local out, buf = {}, {}
	local depth = 0
	local i, n = 1, #src
	local function flush()
		if #buf == 0 then return end
		local line = table.concat(buf)
		buf = {}
		if line:match("^%s*$") then return end
		out[#out + 1] = string.rep("  ", depth > 0 and depth or 0) .. line
	end
	while i <= n do
		local c = src:sub(i, i)
		local eq = src:match("^%[(=*)%[", i)
		if eq then
			local close = "]" .. eq .. "]"
			local j = src:find(close, i, true)
			j = j and (j + #close - 1) or n
			buf[#buf + 1] = src:sub(i, j)
			i = j + 1
		elseif c == "-" and src:sub(i, i + 1) == "--" then
			local j = src:find("\n", i, true) or n
			buf[#buf + 1] = src:sub(i, j)
			i = j + 1
		elseif c == '"' or c == "'" then
			local q, j = c, i + 1
			while j <= n do
				local d = src:sub(j, j)
				if d == "\\" then j = j + 2
				elseif d == q then j = j + 1 break
				else j = j + 1 end
			end
			buf[#buf + 1] = src:sub(i, j - 1)
			i = j
		else
			local w = src:match("^[%a_][%w_]*", i)
			if w then
				buf[#buf + 1] = w
				i = i + #w
				if w == "function" or w == "if" or w == "for" or w == "while" or w == "repeat" then
					depth = depth + 1
				elseif w == "end" or w == "until" then
					depth = depth - 1
					flush()
				elseif w == "then" or w == "do" or w == "else" or w == "elseif" then
					flush()
				end
			else
				if c == ";" then flush() else buf[#buf + 1] = c end
				i = i + 1
			end
		end
	end
	flush()
	return table.concat(out, "\n")
end

-- Все строковые литералы чанка: имена функций, ключи gMethods, URL, Enum-значения.
-- Это то, что переживает виртуализацию: код лежит в байткоде, а константы — в пуле.
local function extractLiterals(src)
	local seen, list = {}, {}
	local i, n = 1, #src
	while i <= n do
		local s = src:find("[\"']", i)
		if not s then break end
		local q = src:sub(s, s)
		local j, buf = s + 1, {}
		while j <= n do
			local c = src:sub(j, j)
			if c == "\\" then
				buf[#buf + 1] = src:sub(j, j + 1)
				j = j + 2
			elseif c == q or c == "\n" then
				break
			else
				buf[#buf + 1] = c
				j = j + 1
			end
		end
		local lit = table.concat(buf)
		if #lit >= 2 and not seen[lit] then
			seen[lit] = true
			list[#list + 1] = lit
		end
		i = j + 1
	end
	table.sort(list)
	return list
end

-- Подбирает уровень длинных скобок, которого нет внутри src
local function longBracket(src)
	for lvl = 0, 8 do
		local eq = string.rep("=", lvl)
		local close = "]" .. eq .. "]"
		if not src:find(close, 1, true) then
			return "[" .. eq .. "[", close
		end
	end
	return nil
end

-- Собирает bundle.lua из двух исходников (stage + payload).
local function emitBundle(stageSrc, payloadSrc)
	if not (type(stageSrc) == "string" and #stageSrc > 0) then return nil end
	if not (type(payloadSrc) == "string" and #payloadSrc > 0) then return nil end
	local o1, c1 = longBracket(stageSrc)
	local o2, c2 = longBracket(payloadSrc)
	if not (o1 and o2) then return nil end
	local bundle = table.concat({
		"--[[ PRISM standalone bundle: no Luarmor, no network.",
		"     Stage and Luraph payload are embedded verbatim, so the virtualised",
		"     initialisation runs exactly as the original does. ]]",
		"local STAGE " .. o1 .. "\n" .. stageSrc .. "\n" .. c1,
		"local PAYLOAD " .. o2 .. "\n" .. payloadSrc .. "\n" .. c2,
		"local BUILD = " .. string.format("%q", "13a0bcaa0ba-nomid"),
		"local orig = loadstring or load",
		"if type(orig) ~= \"function\" then error(\"no loadstring\") end",
		"local armed = true",
		"loadstring = function(s, n)",
		"  if armed and type(s) == \"string\" and s ~= STAGE and #s > 1000000 then",
		"    armed = false",
		"    return orig(PAYLOAD, n or \"=luraph\")",
		"  end",
		"  return orig(s, n)",
		"end",
		"return orig(STAGE)(BUILD)",
	}, "\n")
	return writeOut("bundle.lua", bundle), #bundle
end

-- Ищет уже сохранённый чанк нужного вида в папке вывода.
local function findSaved(kind)
	if type(listfiles) == "function" then
		local ok, files = pcall(listfiles, CONFIG.outDir)
		if ok and type(files) == "table" then
			local best, bestLen = nil, 0
			for _, path in ipairs(files) do
				if type(path) == "string" and path:find(kind, 1, true) and path:sub(-4) == ".lua" then
					local data = readIn(path)
					if data and #data > bestLen then best, bestLen = data, #data end
				end
			end
			return best
		end
	end
	-- без listfiles пробуем типовые имена прошлых прогонов
	for _, name in ipairs({
		CONFIG.outDir .. "/02_luraph_2146762.lua",
		"02_luraph_2146762.lua",
	}) do
		local data = readIn(name)
		if data then return data end
	end
	return nil
end

local function save(src, how, chunkname)
	local kind
	if isProduced(chunkname) or (#src > 100000 and looksReadable(src)) then
		kind = "decompressed"
	else
		kind = classify(src)
	end
	local idx = #captures + 1
	local name = string.format("%02d_%s_%d.lua", idx, kind, #src)
	local path = writeOut(name, src)
	captures[idx] = { i = idx, kind = kind, how = how, bytes = #src, path = path, src = src }
	out(string.format("capture #%d %-12s %8dB  <- %s  %s", idx, kind, #src, how, tostring(path)))
	return captures[idx]
end

-- Глубокая сериализация аргументов пейлоада. Именно из них VM собирает
-- массивы байткода, поэтому без них статический лифт неполон.
local function serializeArgs(...)
	local buf = {}
	local budget = { n = 0 }
	local seen = {}

	local function emit(v, depth)
		local t = type(v)
		if t == "nil" then
			buf[#buf + 1] = "nil"
		elseif t == "boolean" or t == "number" then
			buf[#buf + 1] = tostring(v)
		elseif t == "string" then
			buf[#buf + 1] = string.format("%q", v)
		elseif t == "buffer" then
			local ok = pcall(function()
				local hex = table.create(buffer.len(v) * 2)
				for i = 0, buffer.len(v) - 1 do
					hex[i + 1] = string.format("%02x", buffer.readu8(v, i))
				end
				buf[#buf + 1] = '"__buffer:' .. table.concat(hex) .. '"'
			end)
			if not ok then
				buf[#buf + 1] = '"<buffer:unreadable>"'
			end
		elseif t == "table" then
			if seen[v] then
				buf[#buf + 1] = '"<cycle>"'
				return
			end
			if depth > 8 or budget.n > 400000 then
				buf[#buf + 1] = '"<cut>"'
				return
			end
			seen[v] = true
			budget.n = budget.n + 1
			buf[#buf + 1] = "{"
			if type(getmetatable(v)) == "table" then
				buf[#buf + 1] = '["__meta"]=true,'
			end
			local cnt = 0
			for k, val in pairs(v) do
				local kt = type(k)
				if kt == "number" or kt == "string" then
					cnt = cnt + 1
					if cnt > 20000 then
						buf[#buf + 1] = '["__trunc"]=true,'
						break
					end
					if kt == "number" then
						buf[#buf + 1] = "[" .. tostring(k) .. "]="
					else
						buf[#buf + 1] = "[" .. string.format("%q", k) .. "]="
					end
					emit(val, depth + 1)
					buf[#buf + 1] = ","
				end
			end
			buf[#buf + 1] = "}"
		else
			buf[#buf + 1] = '"<' .. t .. '>"'
		end
	end

	local n = select("#", ...)
	buf[#buf + 1] = "return {__argc=" .. n .. ","
	for i = 1, n do
		buf[#buf + 1] = "[" .. i .. "]="
		emit((select(i, ...)), 0)
		buf[#buf + 1] = ","
	end
	buf[#buf + 1] = "}\n"
	return table.concat(buf), budget.n
end

local function hook(src, chunkname, how)
	if type(src) ~= "string" then
		return ORIG_LS(src, chunkname)
	end
	if stopped then
		return function() return nil end
	end

	local rec = save(src, how, chunkname)
	local fn = ORIG_LS(src, chunkname or ("=layer" .. rec.i))
	if not fn then
		return function() return nil end
	end

	-- распакованный чанк — это цель, исполнять его не нужно
	if not CONFIG.runFinal and (isProduced(chunkname) or (rec.bytes > 100000 and looksReadable(src))) then
		out("decompressed chunk saved; final program not executed")
		stopped = true
		-- финальный чанк получает СВОИ аргументы (буферы с байткодом), а не те,
		-- что летели в пейлоад — снимаем именно их
		return function(...)
			if CONFIG.dumpArgs then
				local okd, dump, nodes = pcall(serializeArgs, ...)
				if okd and type(dump) == "string" then
					local p = writeOut("06_args_final.lua", dump)
					out("final chunk args dumped:", tostring(p), "(" .. #dump .. "B, " .. tostring(nodes) .. " nodes)")
				else
					out("final args dump failed:", tostring(dump):sub(1, 160))
				end
			end
			return nil
		end
	end

	-- пейлоад без исполнения: только сохранить
	if rec.kind == "luraph" and not CONFIG.runPayload then
		stopped = true
		out("luraph payload saved, not executed (set PRISM_EXTRACT_RUN_PAYLOAD=true to decompress)")
		return function() return nil end
	end

	if #captures > CONFIG.maxChunks then
		out("chunk limit passed, not executing further layers")
		return function() return nil end
	end

	return function(...)
		local argc = select("#", ...)
		if rec.kind == "luraph" then
			local parts = {}
			for i = 1, argc do
				local v = select(i, ...)
				parts[#parts + 1] = type(v) .. "=" .. tostring(v):sub(1, 40)
			end
			out("luraph payload invoked with " .. argc .. " arg(s): " .. table.concat(parts, ", "))
			if CONFIG.dumpArgs then
				local okd, dump, nodes = pcall(serializeArgs, ...)
				if okd and type(dump) == "string" then
					local p = writeOut("05_args.lua", dump)
					out("payload args dumped:", tostring(p), "(" .. #dump .. "B, " .. tostring(nodes) .. " nodes)")
				else
					out("args dump failed:", tostring(dump):sub(1, 160))
				end
			end
		end
		depth = depth + 1
		local ok, res = pcall(fn, ...)
		depth = depth - 1
		if not ok then
			out("layer " .. rec.i .. " raised: " .. tostring(res):sub(1, 300))
		end
		return res
	end
end

loadstring = function(src, name) return hook(src, name, "loadstring") end
if type(ORIG_LOAD) == "function" then
	load = function(src, name) return hook(src, name, "load") end
end

-- ------------------------------------------------------------------------- main
local function main()
	out("=== PRISM extractor alive ===")
	out("out:", CONFIG.outDir)
	ensureFolder(CONFIG.outDir)
	if type(writefile) ~= "function" then
		out("WARNING: no writefile — chunks will only be reported, not saved")
	end

	local source = CONFIG.file and readIn(CONFIG.file) or nil
	if not source then
		source = httpGet(CONFIG.url)
	end
	if type(source) ~= "string" or #source == 0 then
		out("no source. set PRISM_EXTRACT_URL or PRISM_EXTRACT_FILE.")
		return
	end
	out("source:", #source .. "B")
	writeOut("00_loader.lua", source)

	local bs = CONFIG.bsdata or extractBsdata(source)
	if bs then
		writeOut("00_bsdata0.txt", bs)
		out("_bsdata0:", #bs .. "B", head(bs, 70))
	end

	-- если дали прямой защищённый скрипт без _bsdata0 — подставим его перед запуском
	local runner = source
	if CONFIG.bsdata and not source:find("_bsdata0%s*=%s*{") then
		runner = "_bsdata0=" .. CONFIG.bsdata .. ";\n" .. source
		out("prepended _bsdata0 from config")
	end

	-- init тянем и сохраняем отдельно: это тоже слой
	local initUrl = source:match("https://cdn%.luarmor%.net/v4_init[%w_%.%-]*")
	local buildId = source:match('local%s+[%w_]+%s*,%s*[%w_]+%s*,%s*[%w_]+%s*=%s*"[^"]*"%s*,%s*"([^"]*)"')
	local stageSrc
	if initUrl then
		out("init url:", initUrl, "build:", tostring(buildId))
		local initSrc = httpGet(initUrl)
		if type(initSrc) == "string" and #initSrc > 0 then
			stageSrc = initSrc
			writeOut("00_init.lua", initSrc)
		end
	end

	-- Быстрый путь: если пейлоад уже лежит на диске с прошлого прогона, бандл
	-- собирается сразу — без запуска цепочки, которая может зависнуть после
	-- того, как ей вернули пустышку вместо исполнения.
	if CONFIG.bundle and stageSrc then
		local saved = findSaved("luraph")
		if saved then
			local p, size = emitBundle(stageSrc, saved)
			if p then
				out("standalone bundle:", p, "(" .. size .. "B)")
				out("payload taken from disk, chain not executed")
				-- но если аргументы финального чанка ещё не сняты — цепочку гоняем
				if not CONFIG.chain and findSaved("06_args_final") then
					return saved
				end
				out("final chunk args missing -> running the chain")
			end
		end
	end

	out("running the chain")
	local fn, cerr = ORIG_LS(runner, "=loader")
	if not fn then
		out("loader does not compile:", tostring(cerr))
		return
	end
	local ok, err = pcall(fn)
	if not ok then
		out("loader raised:", tostring(err):sub(1, 300))
	end

	local lines = {}
	for _, c in ipairs(captures) do
		lines[#lines + 1] = string.format("%02d %-8s %8d B  %s", c.i, c.kind, c.bytes, tostring(c.path))
	end
	local finalRec, decompRec
	for _, c in ipairs(captures) do
		if c.kind == "luraph" and (not finalRec or c.bytes > finalRec.bytes) then
			finalRec = c
		end
		if c.kind == "decompressed" and (not decompRec or c.bytes > decompRec.bytes) then
			decompRec = c
		end
	end
	local manifest = table.concat({
		"url: " .. tostring(CONFIG.url),
		"chunks: " .. #captures,
		"luraph payload: " .. (finalRec and (tostring(finalRec.path) .. " (" .. finalRec.bytes .. "B)") or "not found"),
		"decompressed:   " .. (decompRec and (tostring(decompRec.path) .. " (" .. decompRec.bytes .. "B)") or "not captured"),
		"",
		table.concat(lines, "\n"),
	}, "\n")
	writeOut("manifest.txt", manifest)
	out("\n" .. manifest)
	out("post: manifest written")

	-- ------------------------------------------------------------- standalone bundle
	-- Складываем init + пейлоад внутрь одного файла: в РБ он запускается без
	-- Luarmor и без сети, а виртуализированная инициализация в нём остаётся
	-- рабочей, потому что исполняется оригинальный код, а не его реконструкция.
	-- Делаем это ДО тяжёлой постобработки, чтобы рабочий артефакт появился сразу.
	if CONFIG.bundle and finalRec then
		local stage
		for _, c in ipairs(captures) do
			if c.kind ~= "luraph" and c.kind ~= "decompressed" and c.bytes > 1000 then
				stage = c
				break
			end
		end
		local p, size = emitBundle(stage and stage.src or stageSrc, finalRec.src)
		if p then out("standalone bundle:", p, "(" .. size .. "B)") end
	else
		out("post: bundle skipped")
	end
	out("post: bundle step done")

	if decompRec then
		-- константы: всё, что пережило виртуализацию
		local okLit, lits = pcall(extractLiterals, decompRec.src)
		if okLit and type(lits) == "table" and #lits > 0 then
			local p = writeOut("04_constants.txt", table.concat(lits, "\n"))
			out("constants:", #lits, "unique literal(s) ->", tostring(p))
			local ids = {}
			for _, s in ipairs(lits) do
				if s:match("^[%a_][%w_]*$") and #s > 4 and s:match("%u") then
					ids[#ids + 1] = s
				end
			end
			if #ids > 0 then
				writeOut("04_identifiers.txt", table.concat(ids, "\n"))
				out("identifiers:", #ids, "(API / globals / function names)")
			end
			local urls = {}
			for _, s in ipairs(lits) do
				if s:match("^https?://") then urls[#urls + 1] = s end
			end
			if #urls > 0 then
				writeOut("04_urls.txt", table.concat(urls, "\n"))
				out("urls:", #urls)
			end
		elseif not okLit then
			out("literal scan failed:", tostring(lits):sub(1, 160))
		end
		out("post: constants done")

		if CONFIG.pretty then
			local okPretty, prettySrc = pcall(pretty, decompRec.src)
			if okPretty and type(prettySrc) == "string" and #prettySrc > 0 then
				local p = writeOut(string.format("%02d_decompressed_pretty.lua", decompRec.i), prettySrc)
				if p then
					out("pretty version:", p, "(" .. #prettySrc .. "B)")
				end
			elseif not okPretty then
				out("pretty failed:", tostring(prettySrc):sub(1, 160))
			end
			out("post: pretty done")
		end
	end

	if decompRec and type(setclipboard) == "function" then
		pcall(setclipboard, decompRec.src)
		out("decompressed chunk copied to clipboard")
	elseif finalRec and type(setclipboard) == "function" then
		pcall(setclipboard, finalRec.src)
		out("luraph payload copied to clipboard")
	end
	return finalRec and finalRec.src or nil
end

return main()