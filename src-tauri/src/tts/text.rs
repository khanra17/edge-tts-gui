const MAX_BYTES: usize = 4096;

pub fn clean(text: &str) -> String {
    text.chars()
        .map(|ch| match ch as u32 {
            0..=8 | 11..=12 | 14..=31 => ' ',
            _ => ch,
        })
        .collect()
}

pub fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Split escaped SSML text without cutting Unicode characters or XML entities.
/// Preserve internal whitespace so concatenated requests still match the source.
pub fn split(text: &str) -> Vec<String> {
    let mut remaining = text.trim();
    let mut parts = Vec::new();
    while remaining.len() > MAX_BYTES {
        let safe_end = remaining.floor_char_boundary(MAX_BYTES);
        let mut end = remaining[..safe_end]
            .char_indices()
            .filter(|(_, ch)| "\n.!?,。！？，、；：…".contains(*ch))
            .map(|(index, ch)| index + ch.len_utf8())
            .next_back()
            .unwrap_or(safe_end);
        if let Some(amp) = remaining[..end].rfind('&')
            && !remaining[amp..end].contains(';')
        {
            end = amp;
        }
        parts.push(remaining[..end].to_owned());
        remaining = &remaining[end..];
    }
    if !remaining.is_empty() {
        parts.push(remaining.to_owned());
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_preserve_utf8_and_entities() {
        let text = escape_xml(&"Hello & <世界>. ".repeat(600));
        let parts = split(&text);
        assert_eq!(parts.concat(), text.trim());
        assert!(
            parts
                .iter()
                .all(|part| part.len() <= MAX_BYTES && !part.ends_with('&'))
        );
    }

    #[test]
    fn handles_entity_and_unicode_at_byte_limit() {
        for tail in ["&amp; world", "世界"] {
            let text = format!("{}{tail}", "a".repeat(MAX_BYTES - 2));
            let parts = split(&text);
            assert_eq!(parts.concat(), text);
            assert!(parts.iter().all(|part| part.len() <= MAX_BYTES));
        }
    }

    #[test]
    fn empty_text_has_no_requests() {
        assert!(split(" \n\t").is_empty());
    }

    #[test]
    fn strips_xml_control_characters() {
        assert_eq!(clean("a\u{0}b\u{b}c\n"), "a b c\n");
    }
}
