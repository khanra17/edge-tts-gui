use serde::Serialize;

const VOICES: &str = include_str!("../voices.tsv");

#[derive(Serialize)]
pub struct Voice {
    pub language: &'static str,
    pub name: &'static str,
    pub code: &'static str,
}

pub fn all() -> Vec<Voice> {
    VOICES
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            Some(Voice {
                language: fields.next()?,
                name: fields.next()?,
                code: fields.next()?,
            })
        })
        .collect()
}

pub fn contains(code: &str) -> bool {
    VOICES.lines().any(|line| {
        line.rsplit_once('\t')
            .is_some_and(|(_, value)| value == code)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_voices_are_valid_and_unique() {
        let voices = all();
        assert!(!voices.is_empty());
        assert!(contains("en-US, AvaNeural"));
        let codes: std::collections::HashSet<_> = voices.iter().map(|voice| voice.code).collect();
        assert_eq!(codes.len(), voices.len());
        assert!(
            voices
                .iter()
                .all(|voice| !voice.language.is_empty() && !voice.name.is_empty())
        );
    }
}
