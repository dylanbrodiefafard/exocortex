/// A parsed INI document.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ini {
    sections: Vec<Section>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Section {
    name: String,
    entries: Vec<(String, String)>,
}

impl Ini {
    /// Returns the value of `key` in `section`, if present.
    pub fn get(&self, section: &str, key: &str) -> Option<&str> {
        self.sections
            .iter()
            .find(|s| s.name == section)?
            .entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// Section names in the order they first appear in the input.
    pub fn sections(&self) -> Vec<&str> {
        self.sections.iter().map(|s| s.name.as_str()).collect()
    }

    pub(crate) fn add_section(&mut self, name: &str) {
        if !self.sections.iter().any(|s| s.name == name) {
            self.sections.push(Section {
                name: name.to_string(),
                entries: Vec::new(),
            });
        }
    }

    pub(crate) fn insert(&mut self, section: &str, key: &str, value: String) {
        self.add_section(section);
        let section = self
            .sections
            .iter_mut()
            .find(|s| s.name == section)
            .expect("section was just added");
        section.entries.push((key.to_string(), value));
    }
}
