test("remote MCP exposes authenticated autonomous task tools and stores only hashed credentials", () => {
  assert.match(worker, /if \(url\.pathname === "\/mcp"\) return handleMcp/);
  assert.match(worker, /newchat_start_task/);
  assert.match(worker, /newchat_get_task/);
  assert.match(worker, /newchat_cancel_task/);
  assert.match(worker, /token_hash=eq\./);
  assert.match(worker, /sha256Hex\(token\)/);
  assert.match(worker, /plan created through remote MCP/i);
});
