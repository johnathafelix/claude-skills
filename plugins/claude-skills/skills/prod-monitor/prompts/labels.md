1. Call ToolSearch with query "select:{{tool}}". If the tool is missing, still connecting, or asks to authenticate, stop and answer status "unavailable" with the reason in detail.
2. For each configured label name in {{labels}}, call {{tool}} once with team "{{team}}" and name set to that configured name exactly as written. From the result, pick the label whose name equals the configured name ignoring case (not a label that merely contains it). Add {"configured", "name", "id", "created": false} to labels, with name and id copied character for character from the result.
3. {{missing_step}}
4. Answer status "ok" with the labels. A failed call means status "error" with its message in detail. Return minimal schema JSON, no commentary.
