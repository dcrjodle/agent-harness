# .NET
- `async`/`await` for async; `ValueTask` on hot paths. Dispose `IDisposable`.
- PascalCase public, `_camelCase` private fields, camelCase locals/params.
- No comments or XML docs — self-explanatory code.
- xUnit: Arrange/Act/Assert, `[Fact]`/`[Theory]`.
- Verify: `dotnet build`. Before commit: `dotnet format`.
