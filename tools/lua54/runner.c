/* PRISM minimal Lua 5.4 runner: links the system liblua-5.4.so (no headers needed).
 * Build: cc -O2 -o tools/lua54/lua54 tools/lua54/runner.c /usr/lib64/liblua-5.4.so -lm -ldl
 * Usage: lua54 script.lua   (errors -> stderr with traceback, exit 1)
 * Used only to CHECK a lift against the original (QA) — deobfuscation itself stays static. */
#include <stdio.h>
#include <stdint.h>
#include <stddef.h>
typedef struct lua_State lua_State;
typedef int (*lua_CFunction)(lua_State *L);
typedef intptr_t lua_KContext;
typedef int (*lua_KFunction)(lua_State *L, int status, lua_KContext ctx);
extern lua_State *luaL_newstate(void);
extern void luaL_openlibs(lua_State *L);
extern int luaL_loadfilex(lua_State *L, const char *filename, const char *mode);
extern int lua_pcallk(lua_State *L, int nargs, int nresults, int errfunc, lua_KContext ctx, lua_KFunction k);
extern const char *lua_tolstring(lua_State *L, int idx, size_t *len);
extern void luaL_traceback(lua_State *L, lua_State *L1, const char *msg, int level);
extern void lua_pushcclosure(lua_State *L, lua_CFunction fn, int n);
extern void lua_close(lua_State *L);

static int msgh(lua_State *L) {
  const char *msg = lua_tolstring(L, 1, NULL);
  luaL_traceback(L, L, msg ? msg : "(error object is not a string)", 1);
  return 1;
}

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: lua54 script.lua\n"); return 2; }
  lua_State *L = luaL_newstate();
  if (!L) { fprintf(stderr, "cannot create state\n"); return 2; }
  luaL_openlibs(L);
  lua_pushcclosure(L, msgh, 0);
  if (luaL_loadfilex(L, argv[1], NULL) != 0) { fflush(stdout); fprintf(stderr, "%s\n", lua_tolstring(L, -1, NULL)); return 1; }
  if (lua_pcallk(L, 0, 0, 1, 0, NULL) != 0) { fflush(stdout); fprintf(stderr, "%s\n", lua_tolstring(L, -1, NULL)); return 1; }
  fflush(stdout);
  lua_close(L);
  return 0;
}
