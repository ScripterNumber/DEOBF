-- PRISM vm_specialize: residual program of the VM interpreter (one maker per proto).
-- PROTOS[n](upvalues) returns the closure for proto n; PROTO_n / K_n are records of the dump.
-- interpreter runs inside a protected call (E[33]()); handler returns are routed through its 1-statement epilogue
-- interpreter: fetch t = s[W] @L1406; proto param 'R', fields X=[9] x=[4] j=[2] U=[1] I=[10] o=[3] N=[6] s=[11] y=[5]; closure maker stored in E[57]
-- 3 proto(s) in the dump: #1(1118) #10(6) #19(36)
-- helper table E: 37 library function slot(s) resolved
-- self-modifying bytecode: 38 written slot(s); 52 patched-slot read(s) resolved statically (4 phase(s)), 4 selected at run time, 12 one-time patch trampoline(s) folded (the patching chain always runs; its stores are idempotent, its scratch registers are dead at the join), 14 unreachable block(s) removed
-- 36 self-modifying opcode store(s) removed (the patched opcode has the same meaning)
-- 1630 helper-table read(s) replaced by library functions
-- patch round 1: 28 written slot(s) of dump records (1 with computed values)
-- patch round 2: 30 written slot(s) of dump records (0 with computed values)
-- patch round 3: 30 written slot(s) of dump records (0 with computed values)
-- patch rounds oscillate: union of the last two patch sets used
-- patch check: 2 store(s) found in the cleaned code outside the patch set (K_3[261], K_7[797]) — another round
-- one-time patch flags: 38 guard value(s) imply 330 slot value(s) (the slots the patch chain closed by the flag always writes; verified self-consistent in 4 analysis phase(s))
-- patched-slot reads in the structured code: 0 resolved, 4 still read at run time (K_7×3, K_25×1)
-- 16 store(s) into 5 record(s) that are never read any more removed
-- 12 idempotent record guard(s) folded
-- 29 store(s) into 4 dump record(s) and 1 one-time patch guard(s) removed: the residual program never reads these records otherwise (self-modifying bytecode leftovers)
-- 6 multiple-results / varargs register range(s) fused back into calls, returns, assignments and table constructors (registers above an instruction's operands are taken as dead after it, as in compiled code)
-- run-time written slots of dump records (self-modifying bytecode): 38
--   K_31[101] <- 15
--   K_7[1053] <- 185
--   K_7[171] <- 17
--   K_31[171] <- 127
--   K_7[257] <- 169
--   K_2[956] <- 9
--   K_7[45] <- 1079
--   K_31[254] <- 175
--   K_7[828] <- 250
--   K_31[1104] <- 40
--   K_7[740] <- 17
--   K_3[597] <- 9
--   K_7[18] <- 8
--   K_2[900] <- 20
--   K_7[99] <- 894
--   K_2[655] <- 19
--   K_7[1118] <- 455
--   K_31[1076] <- 31
--   K_7[549] <- 130
--   K_2[177] <- 19
--   K_7[686] <- 176
--   K_31[746] <- 87
--   K_7[555] <- 1057
--   K_29[9] <- 121
--   K_20[9] <- 13
--   K_20[30] <- 0
--   K_29[30] <- 30
--   K_25[29] <- 1
--   K_25[12] <- 1
--   K_25[2] <- 13
--   K_7[608] <- 5
--   K_31[608] <- 166
--   K_3[608] <- 0
--   K_7[873] <- 607
--   K_31[378] <- 93
--   K_7[554] <- 377
--   K_3[261] <- 30
--   K_7[797] <- 257
local PROTOS = {}
-- proto 1: 1118 instructions, 290 blocks, structured
PROTOS[1] = function(k, K)
  K = function(...)
    local W, h, l, M, H, T, L = 1, table.create(56), 1;
    local h_0, h_1, h_2, h_3, h_4, h_5, h_6, h_7, h_8, h_9, h_10, h_11, h_12, h_13, h_14, h_15, h_16, h_17, h_18, h_19, h_20, h_21, h_22, h_23, h_24, h_25, h_26, h_27, h_28, h_29, h_30, h_31, h_32, h_33, h_34, h_35, h_36, h_37, h_38, h_39, h_40, h_41, h_42, h_43, h_44, h_45, h_46, h_47, h_48, h_49;
    local S, w, m, i = 0, 1, (getfenv());
    local g, V;
    local u, p, D, J, a, z, P, A, d;
    h_1 = print;
    h_2 = string["rep"]("=", 59);
    h_2 = "=" .. h_2;
    h_1(h_2);
    print("MINI RPG WORLD GENERATOR");
    h_1 = print;
    h_2 = string["rep"]("=", 59);
    h_2 = "=" .. h_2;
    h_1(h_2);
    print("Reference: https://create.roblox.com/docs/luau");
    print("");
    p = PROTOS[10](false);
    h_2 = p();
    h_3 = table.create(8);
    h_4 = {};
    h_4["name"] = "Plains";
    h_4["sym"] = ".";
    h_5 = {};
    h_5["name"] = "Forest";
    h_5["sym"] = "f";
    h_6 = {};
    h_6["name"] = "Hills";
    h_6["sym"] = "^";
    h_7 = {};
    h_7["name"] = "Mountains";
    h_7["sym"] = "M";
    h_8 = {};
    h_8["name"] = "Water";
    h_8["sym"] = "~";
    h_9 = {};
    h_9["name"] = "Desert";
    h_9["sym"] = ":";
    h_10 = {};
    h_10["name"] = "Swamp";
    h_10["sym"] = "s";
    h_11 = {};
    h_11["name"] = "Tundra";
    h_11["sym"] = "t";
    h_3[1] = h_4;
    h_3[2] = h_5;
    h_3[3] = h_6;
    h_3[4] = h_7;
    h_3[5] = h_8;
    h_3[6] = h_9;
    h_3[7] = h_10;
    h_3[8] = h_11;
    print("TERRAIN TYPES:");
    L = { [5] = nil, [1] = nil, [3] = nil, [4] = nil };
    M = #h_3 + 0;
    i = 0;
    while true do
      i = i + 1;
      if i <= M then
        h_8 = print;
        h_9 = tostring(i);
        h_11 = " [" .. h_3[i]["sym"] .. "]";
        h_10 = ". " .. h_3[i]["name"] .. h_11;
        P = h_9 .. h_10;
        h_9 = "  " .. P;
        h_8(h_9);
        continue;
      end
      break;
    end
    i = L[4];
    M = L[1];
    T = L[3];
    L = L[5];
    print("");
    h_6 = {};
    h_7 = print;
    h_8 = tostring(40);
    h_9 = tostring(20);
    h_9 = h_9 .. "):";
    h_9 = "x" .. h_9;
    P = h_8 .. h_9;
    h_7("WORLD MAP (" .. P);
    h_7 = print;
    h_8 = string["rep"]("-", 40);
    h_8 = h_8 .. "+";
    h_8 = "+" .. h_8;
    h_7(h_8);
    L = { [5] = L, [1] = M, [3] = T, [4] = i };
    T = 1;
    M = 20;
    i = 0;
    while true do
      i = i + T;
      if not (T <= 0) then
        g = i <= M;
      else
        g = i >= M;
      end
      if g then
        h_10 = i;
        h_11 = "|";
        L = { [5] = L, [1] = M, [3] = T, [4] = i };
        i = 1;
        while i <= 40 do
          h_16 = math["sin"](i * 0.2);
          h_17 = math["cos"](h_10 * 0.2);
          h_16 = h_16 * h_17;
          h_17 = math["sin"](i * 0.5);
          h_17 = 0.4 * h_17;
          h_19 = h_10 * 0.5;
          h_18 = math["cos"](h_19);
          h_17 = h_17 * h_18;
          h_16 = h_16 + h_17;
          P = (h_16 + 1) / 2;
          if not not (P < 0.2) then
            h_17 = 5;
          elseif not not (P < 0.35) then
            h_17 = 1;
          elseif not not (P < 0.55) then
            h_17 = 2;
          elseif not not (P < 0.75) then
            h_17 = 3;
          else
            h_17 = 4;
          end
          if h_6[h_10] ~= nil then
          else
            h_18 = {};
            h_6[h_10] = h_18;
          end
          h_6[h_10][i] = h_17;
          h_18 = h_3[h_17]["sym"];
          P = h_11 .. h_18;
          h_11 = P;
          i = i + 1;
        end
        i = L[4];
        M = L[1];
        T = L[3];
        L = L[5];
        h_13 = h_11 .. "|";
        print(h_13);
        continue;
      end
      break;
    end
    i = L[4];
    M = L[1];
    T = L[3];
    L = L[5];
    h_7 = print;
    h_8 = string["rep"]("-", 40);
    h_8 = h_8 .. "+";
    h_8 = "+" .. h_8;
    h_7(h_8);
    print("");
    h_7 = table.create(6);
    h_7[1] = "Oakvale";
    h_7[2] = "Riverwood";
    h_7[3] = "Stonehaven";
    h_7[4] = "Mistwall";
    h_7[5] = "Dawnstar";
    h_7[6] = "Falconreach";
    h_8 = {};
    print("TOWNS:");
    L = { [5] = L, [1] = M, [3] = T, [4] = i };
    i = 1;
    while i <= 8 do
      h_14 = h_2();
      h_14 = h_14 * 38;
      h_13 = math.floor(h_14);
      h_13 = h_13 + 2;
      h_15 = h_2();
      h_15 = h_15 * 18;
      h_14 = math.floor(h_15);
      h_14 = h_14 + 2;
      h_16 = h_2();
      h_16 = h_16 * #h_7;
      h_15 = math.floor(h_16);
      h_15 = h_15 + 1;
      h_17 = h_2();
      h_17 = h_17 * 100;
      h_16 = math.floor(h_17);
      h_16 = h_16 + 1;
      h_17 = h_7[h_15];
      h_18 = tostring(h_16);
      h_18 = " " .. h_18;
      h_17 = h_17 .. h_18;
      h_20 = {};
      h_20["name"] = h_17;
      h_20["x"] = h_13;
      h_20["y"] = h_14;
      table.insert(h_8, h_20);
      h_18 = print;
      h_19 = tostring(i);
      h_20 = tostring(h_13);
      h_21 = tostring(h_14);
      h_21 = h_21 .. ")";
      h_21 = "," .. h_21;
      h_20 = h_20 .. h_21;
      h_20 = " at (" .. h_20;
      h_20 = h_17 .. h_20;
      h_20 = ". " .. h_20;
      P = h_19 .. h_20;
      h_19 = "  " .. P;
      h_18(h_19);
      i = i + 1;
    end
    i = L[4];
    M = L[1];
    T = L[3];
    L = L[5];
    print("");
    h_9 = table.create(4);
    h_10 = {};
    h_10["name"] = "Arthas";
    h_10["class"] = "Warrior";
    h_10["hp"] = 100;
    h_10["dmg"] = 25;
    P = {};
    P["name"] = "Liliana";
    P["class"] = "Mage";
    P["hp"] = 70;
    P["dmg"] = 35;
    h_12 = {};
    h_12["name"] = "Rexar";
    h_12["class"] = "Hunter";
    h_12["hp"] = 85;
    h_12["dmg"] = 28;
    h_13 = {};
    h_13["name"] = "Maiev";
    h_13["class"] = "Rogue";
    h_13["hp"] = 75;
    h_13["dmg"] = 32;
    h_9[1] = h_10;
    h_9[2] = P;
    h_9[3] = h_12;
    h_9[4] = h_13;
    print("HEROES:");
    L = { [5] = L, [1] = M, [3] = T, [4] = i };
    M = #h_9 + 0;
    i = 0;
    while true do
      i = i + 1;
      if i <= M then
        h_14 = h_9[i];
        h_15 = print;
        h_16 = tostring(i);
        h_17 = h_14["name"];
        h_18 = h_14["class"];
        h_19 = tostring(h_14["hp"]);
        h_21 = h_14["dmg"];
        h_20 = tostring(h_21);
        h_20 = " | DMG:" .. h_20;
        h_19 = h_19 .. h_20;
        h_19 = " | HP:" .. h_19;
        h_18 = h_18 .. h_19;
        h_18 = " the " .. h_18;
        h_17 = h_17 .. h_18;
        h_17 = ". " .. h_17;
        P = h_16 .. h_17;
        h_16 = "  " .. P;
        h_15(h_16);
        continue;
      end
      break;
    end
    i = L[4];
    M = L[1];
    T = L[3];
    L = L[5];
    print("");
    print("COMBAT SIMULATION:");
    h_10 = h_9[1];
    h_11 = h_9[2];
    h_12 = h_10["hp"];
    h_13 = h_11["hp"];
    P = h_10["name"] .. " vs " .. h_11["name"];
    print("  " .. P);
    L = { [5] = L, [1] = M, [3] = T, [4] = i };
    i = 1;
    while true do
      if i <= 5 then
        if not (h_12 <= 0) then
          if not not (h_13 <= 0) then
          else
            h_19 = h_2();
            h_19 = h_19 * h_10["dmg"];
            h_18 = math.floor(h_19);
            h_18 = h_18 + 10;
            h_20 = h_2();
            h_20 = h_20 * h_11["dmg"];
            h_19 = math.floor(h_20);
            h_19 = h_19 + 10;
            h_13 = h_13 - h_18;
            h_20 = print;
            h_21 = tostring(i);
            h_22 = h_10["name"];
            h_23 = tostring(h_18);
            h_24 = h_11["name"];
            h_25 = tostring;
            h_25 = h_25(math.max(0, h_13));
            h_25 = " HP: " .. h_25;
            h_24 = h_24 .. h_25;
            h_24 = " -> " .. h_24;
            h_23 = h_23 .. h_24;
            h_23 = " hits for " .. h_23;
            h_22 = h_22 .. h_23;
            h_22 = ": " .. h_22;
            P = h_21 .. h_22;
            h_21 = "  Turn " .. P;
            h_20(h_21);
            if not not (0 < h_13) then
              h_12 = h_12 - h_19;
              h_20 = print;
              h_21 = h_11["name"];
              h_22 = tostring(h_19);
              h_23 = h_10["name"];
              h_24 = tostring;
              h_24 = h_24(math.max(0, h_12));
              h_24 = " HP: " .. h_24;
              h_23 = h_23 .. h_24;
              h_23 = " -> " .. h_23;
              h_22 = h_22 .. h_23;
              h_22 = " hits for " .. h_22;
              h_21 = h_21 .. h_22;
              h_21 = "           " .. h_21;
              h_20(h_21);
            end
            i = i + 1;
            continue;
          end
        end
      end
      break;
    end
    i = L[4];
    M = L[1];
    T = L[3];
    L = L[5];
    if not not (h_12 <= 0) then
      h_15 = "  WINNER: " .. h_11["name"];
      print(h_15);
    elseif not not (h_13 <= 0) then
      h_15 = "  WINNER: " .. h_10["name"];
      print(h_15);
    else
      print("  DRAW!");
    end
    print("");
    h_14 = table.create(6);
    h_14[1] = "Iron Sword";
    h_14[2] = "Leather Armor";
    h_14[3] = "Health Potion";
    h_14[4] = "Mana Potion";
    h_14[5] = "Steel Shield";
    h_14[6] = "Magic Ring";
    print("SHOP ITEMS:");
    L = { [5] = L, [1] = M, [3] = T, [4] = i };
    M = #h_14 + 0;
    i = 0;
    while true do
      i = i + 1;
      if i <= M then
        h_20 = h_2();
        h_20 = h_20 * 100;
        h_19 = math.floor(h_20);
        h_19 = h_19 + 20;
        h_20 = print;
        h_21 = tostring(i);
        h_22 = h_14[i];
        h_23 = tostring(h_19);
        h_23 = h_23 .. " gold";
        h_23 = " - " .. h_23;
        P = h_22 .. h_23;
        h_22 = ". " .. P;
        h_21 = h_21 .. h_22;
        h_21 = "  " .. h_21;
        h_20(h_21);
        continue;
      end
      break;
    end
    i = L[4];
    M = L[1];
    T = L[3];
    L = L[5];
    print("");
    h_15 = table.create(6);
    h_15[1] = "Kill 5 goblins";
    h_15[2] = "Find the lost artifact";
    h_15[3] = "Escort the merchant";
    h_15[4] = "Clear the dungeon";
    h_15[5] = "Deliver the message";
    h_15[6] = "Defeat the dragon";
    h_16 = 0;
    print("QUESTS:");
    L = { [5] = L, [1] = M, [3] = T, [4] = i };
    M = #h_15 + 0;
    i = 0;
    while true do
      i = i + 1;
      if i <= M then
        h_22 = h_2();
        h_22 = h_22 * 150;
        h_21 = math.floor(h_22);
        h_21 = h_21 + 50;
        h_22 = h_2();
        if not not (h_22 < 0.3) then
          h_16 = h_16 + 1;
          h_22 = print;
          h_23 = h_15[i];
          h_24 = tostring(h_21);
          h_24 = h_24 .. " gold)";
          h_24 = " (+" .. h_24;
          P = h_23 .. h_24;
          h_23 = "  [X] " .. P;
          h_22(h_23);
        else
          h_22 = print;
          h_23 = h_15[i];
          h_24 = tostring(h_21);
          h_24 = h_24 .. " gold)";
          h_24 = " (" .. h_24;
          P = h_23 .. h_24;
          h_23 = "  [ ] " .. P;
          h_22(h_23);
        end
        continue;
      end
      break;
    end
    i = L[4];
    M = L[1];
    T = L[3];
    L = L[5];
    h_17 = print;
    h_18 = tostring(h_16);
    h_19 = tostring(#h_15);
    h_19 = "/" .. h_19;
    h_18 = h_18 .. h_19;
    h_18 = "  Completed: " .. h_18;
    h_17(h_18);
    print("");
    h_17 = {};
    h_17["name"] = "Shadow Crypt";
    h_17["floors"] = 5;
    h_18 = table.create(5);
    h_18[1] = 5;
    h_18[2] = 4;
    h_18[3] = 3;
    h_18[4] = 3;
    h_18[5] = 2;
    print("DUNGEON: " .. h_17["name"]);
    h_19 = 100;
    h_20 = 0;
    h_22 = h_17["floors"];
    L = { [5] = L, [1] = M, [3] = T, [4] = i };
    T = 1;
    M = h_22 + 0;
    i = 0;
    while true do
      i = i + T;
      if not (T <= 0) then
        g = i <= M;
      else
        g = i >= M;
      end
      if g then
        h_24 = i;
        h_25 = h_18[i];
        if h_25 ~= nil then
        else
          h_25 = 3;
        end
        h_26 = print;
        h_27 = tostring(i);
        h_28 = tostring(h_25);
        h_28 = h_28 .. " enemies";
        h_28 = " - " .. h_28;
        P = h_27 .. h_28;
        h_26("  Floor " .. P);
        L = { [5] = L, [1] = M, [3] = T, [4] = i };
        M = h_25 + 0;
        i = 0;
        while true do
          i = i + 1;
          if i <= M then
            h_31 = h_2();
            h_31 = h_31 * 30;
            h_30 = math.floor(h_31);
            h_30 = h_30 + 10;
            h_19 = h_19 - h_30;
            h_31 = print;
            h_32 = tostring(i);
            h_33 = tostring(h_30);
            h_34 = tostring;
            h_34 = h_34(math.max(0, h_19));
            h_34 = " dmg | Party HP: " .. h_34;
            P = h_33 .. h_34;
            h_33 = " deals " .. P;
            h_32 = h_32 .. h_33;
            h_32 = "    Enemy " .. h_32;
            h_31(h_32);
            if not not (h_19 <= 0) then
            else
              continue;
            end
          end
          break;
        end
        i = L[4];
        M = L[1];
        T = L[3];
        L = L[5];
        if not not (h_19 <= 0) then
          h_26 = print;
          h_27 = tostring(h_24);
          h_27 = h_27 .. "!";
          h_27 = "  PARTY DIED at floor " .. h_27;
          h_26(h_27);
        else
          h_27 = h_2();
          h_27 = h_27 * 100;
          h_26 = math.floor(h_27);
          h_26 = h_26 + 20;
          h_20 = h_20 + h_26;
          h_27 = print;
          h_28 = tostring(h_26);
          h_29 = tostring(h_20);
          h_29 = h_29 .. ")";
          h_29 = " gold (total: " .. h_29;
          h_28 = h_28 .. h_29;
          h_28 = "    Floor cleared! +" .. h_28;
          h_27(h_28);
          continue;
        end
      end
      break;
    end
    if not not (0 < h_19) then
      h_21 = print;
      h_22 = tostring(h_19);
      h_23 = tostring(h_20);
      h_23 = " | Gold: " .. h_23;
      P = h_22 .. h_23;
      h_22 = "  DUNGEON CLEARED! Final HP: " .. P;
      h_21(h_22);
    end
    print("");
    h_21 = table.create(5);
    h_21[1] = "Sunny";
    h_21[2] = "Rain";
    h_21[3] = "Storm";
    h_21[4] = "Snow";
    h_21[5] = "Fog";
    print("WEATHER LOG (10 days):");
    h_27 = h_2();
    h_27 = h_27 * #h_21;
    h_26 = math.floor(h_27);
    h_26 = h_26 + 1;
    h_27 = h_21[h_26];
    h_28 = tostring(1);
    h_28 = " " .. h_28;
    print("  Day " .. h_28 .. ": " .. h_27);
    h_27 = h_2();
    h_27 = h_27 * #h_21;
    h_26 = math.floor(h_27);
    h_26 = h_26 + 1;
    h_27 = h_21[h_26];
    h_28 = tostring(2);
    h_28 = " " .. h_28;
    print("  Day " .. h_28 .. ": " .. h_27);
    h_27 = h_2();
    h_27 = h_27 * #h_21;
    h_26 = math.floor(h_27);
    h_26 = h_26 + 1;
    h_27 = h_21[h_26];
    h_28 = tostring(3);
    h_28 = " " .. h_28;
    print("  Day " .. h_28 .. ": " .. h_27);
    h_27 = h_2();
    h_27 = h_27 * #h_21;
    h_26 = math.floor(h_27);
    h_26 = h_26 + 1;
    h_27 = h_21[h_26];
    h_28 = tostring(4);
    h_28 = " " .. h_28;
    print("  Day " .. h_28 .. ": " .. h_27);
    h_27 = h_2();
    h_27 = h_27 * #h_21;
    h_26 = math.floor(h_27);
    h_26 = h_26 + 1;
    h_27 = h_21[h_26];
    h_28 = tostring(5);
    h_28 = " " .. h_28;
    print("  Day " .. h_28 .. ": " .. h_27);
    h_27 = h_2();
    h_27 = h_27 * #h_21;
    h_26 = math.floor(h_27);
    h_26 = h_26 + 1;
    h_27 = h_21[h_26];
    h_28 = tostring(6);
    h_28 = " " .. h_28;
    print("  Day " .. h_28 .. ": " .. h_27);
    h_27 = h_2();
    h_27 = h_27 * #h_21;
    h_26 = math.floor(h_27);
    h_26 = h_26 + 1;
    h_27 = h_21[h_26];
    h_28 = tostring(7);
    h_28 = " " .. h_28;
    print("  Day " .. h_28 .. ": " .. h_27);
    h_27 = h_2();
    h_27 = h_27 * #h_21;
    h_26 = math.floor(h_27);
    h_26 = h_26 + 1;
    h_27 = h_21[h_26];
    h_28 = tostring(8);
    h_28 = " " .. h_28;
    print("  Day " .. h_28 .. ": " .. h_27);
    h_27 = h_2();
    h_27 = h_27 * #h_21;
    h_26 = math.floor(h_27);
    h_26 = h_26 + 1;
    h_27 = h_21[h_26];
    h_28 = tostring(9);
    h_28 = " " .. h_28;
    print("  Day " .. h_28 .. ": " .. h_27);
    h_27 = h_2();
    h_27 = h_27 * #h_21;
    h_26 = math.floor(h_27);
    h_26 = h_26 + 1;
    h_27 = h_21[h_26];
    h_28 = tostring(10);
    print("  Day " .. h_28 .. ": " .. h_27);
    print("");
    h_22 = print;
    h_23 = string["rep"]("=", 59);
    h_23 = "=" .. h_23;
    h_22(h_23);
    print("FINAL STATS:");
    h_22 = print;
    h_23 = tostring(800);
    h_23 = "  Map cells: " .. h_23;
    h_22(h_23);
    h_22 = print;
    h_23 = tostring(#h_8);
    h_23 = "  Towns: " .. h_23;
    h_22(h_23);
    h_22 = print;
    h_23 = tostring(#h_9);
    h_23 = "  Heroes: " .. h_23;
    h_22(h_23);
    h_22 = print;
    h_23 = tostring(h_16);
    h_24 = tostring(#h_15);
    h_24 = "/" .. h_24;
    h_23 = h_23 .. h_24;
    h_23 = "  Quests completed: " .. h_23;
    h_22(h_23);
    h_22 = print;
    h_23 = tostring(h_20);
    h_23 = "  Dungeon gold: " .. h_23;
    h_22(h_23);
    h_22 = print;
    h_23 = string["rep"]("=", 59);
    h_23 = "=" .. h_23;
    h_22(h_23);
    print("GENERATION COMPLETE!");
    print("https://create.roblox.com/docs/luau");
    return;
  end;
  return K;
end;

-- proto 10: 6 instructions, 3 blocks, structured
PROTOS[10] = function(k, K)
  K = function(...)
    local W, h, l, M, H, T, L = 1, table.create(4), 1;
    local S, w, m, i = 0, 1, (getfenv());
    local u, p, D, J, a, z, P, A, d;
    h[1] = 12345;
    A = {};
    p = PROTOS[19](A);
    if A then
      H = {};
      u = H[1];
      if not u then
        u = { [1] = 1, [2] = h };
        H[1] = u;
      end
      A[0] = u;
    end
    if not H then
    else
      for R, X in H do
        if R >= 1 then
          X[2] = X;
          X[3] = h[R];
          X[1] = 3;
          H[R] = nil;
        end
      end
    end
    return p;
  end;
  return K;
end;

-- proto 19: 36 instructions, 11 blocks, structured
PROTOS[19] = function(k, K)
  K = function(...)
    local W, h, l, M, H, T, L = 1, table.create(22), 1;
    local h_1, h_4, h_5, h_6, h_7, h_8, h_9, h_10, h_11, h_12, h_13, h_14, h_15, h_16, h_17, h_18, h_19, h_20, h_21;
    local S, w, m, i = 0, 1, (getfenv());
    local g, V;
    g = k[0];
    h_1 = (g[2][g[1]] * 1103515245 + 12345) % 4294967296;
    g = k[0];
    g[2][g[1]] = h_1;
    g = k[0];
    return g[2][g[1]] / 4294967296;
  end;
  return K;
end;
