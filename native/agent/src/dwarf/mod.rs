use gimli::{
    AttributeValue, BaseAddresses, CfaRule, DebugFrame, Dwarf, EhFrame, EndianSlice, Operation,
    RunTimeEndian, SectionId, UnwindContext, UnwindSection,
};
use object::{Object, ObjectSection};
use std::{
    borrow::Cow,
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineSite {
    pub address: u64,
    pub file: String,
    pub line: u64,
    pub inline_chain: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ResolutionError {
    #[error("no-debug-info")]
    NoDebugInfo,
    #[error("no-line-info")]
    NoLineInfo,
    #[error("source-file-not-found: {0}")]
    SourceFileNotFound(String),
    #[error("source-file-ambiguous: suffix {suffix} matches distinct files: {candidates:?}")]
    SourceFileAmbiguous {
        suffix: String,
        candidates: Vec<String>,
    },
    #[error("no-executable-address: {0}")]
    NoExecutableAddress(String),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

pub fn resolve_line(
    path: &Path,
    source_suffix: &str,
    requested_line: u64,
) -> Result<Vec<LineSite>, ResolutionError> {
    let bytes = fs::read(path).map_err(|error| ResolutionError::Other(error.into()))?;
    let object = object::File::parse(bytes.as_slice())
        .map_err(|error| ResolutionError::Other(error.into()))?;
    if object.section_by_name(".debug_info").is_none() {
        return Err(ResolutionError::NoDebugInfo);
    }
    let endian = if object.is_little_endian() {
        RunTimeEndian::Little
    } else {
        RunTimeEndian::Big
    };
    let load = |id: SectionId| -> Result<Cow<'_, [u8]>, gimli::Error> {
        Ok(object
            .section_by_name(id.name())
            .and_then(|section| section.uncompressed_data().ok())
            .unwrap_or(Cow::Borrowed(&[])))
    };
    let dwarf_cow = Dwarf::load(load).map_err(|error| ResolutionError::Other(error.into()))?;
    let dwarf = dwarf_cow.borrow(|section| EndianSlice::new(section, endian));
    let mut units = dwarf.units();
    let mut sites = Vec::new();
    let mut saw_lines = false;
    let mut saw_file = false;
    let mut matched_files = BTreeSet::new();
    while let Some(header) = units
        .next()
        .map_err(|error| ResolutionError::Other(error.into()))?
    {
        let unit = dwarf
            .unit(header)
            .map_err(|error| ResolutionError::Other(error.into()))?;
        let Some(program) = unit.line_program.clone() else {
            continue;
        };
        saw_lines = true;
        let (program, sequences) = program
            .sequences()
            .map_err(|error| ResolutionError::Other(error.into()))?;
        for sequence in sequences {
            let mut rows = program.resume_from(&sequence);
            while let Some((header, row)) = rows
                .next_row()
                .map_err(|error| ResolutionError::Other(error.into()))?
            {
                if row.end_sequence() || row.line().map(|line| line.get()) != Some(requested_line) {
                    continue;
                }
                let Some(file) = row.file(header) else {
                    continue;
                };
                let raw = dwarf
                    .attr_string(&unit, file.path_name())
                    .map_err(|error| ResolutionError::Other(error.into()))?;
                let name = raw.to_string_lossy();
                let directory = file
                    .directory(header)
                    .and_then(|value| dwarf.attr_string(&unit, value).ok())
                    .map(|value| value.to_string_lossy().into_owned());
                let compilation_directory = unit
                    .comp_dir
                    .as_ref()
                    .map(|value| value.to_string_lossy().into_owned());
                let mut candidates = vec![normalize_path(&name)];
                if let Some(directory) = &directory {
                    candidates.push(normalize_path(&format!("{directory}/{name}")));
                }
                if let Some(compilation_directory) = &compilation_directory {
                    candidates.push(normalize_path(&format!("{compilation_directory}/{name}")));
                    if let Some(directory) = &directory {
                        candidates.push(normalize_path(&format!(
                            "{compilation_directory}/{directory}/{name}"
                        )));
                    }
                }
                let requested = normalize_path(source_suffix);
                let Some(normalized) = candidates
                    .into_iter()
                    .filter(|candidate| candidate.ends_with(&requested))
                    .max_by_key(|candidate| (candidate.split('/').count(), candidate.len()))
                else {
                    continue;
                };
                saw_file = true;
                matched_files.insert(normalized.clone());
                sites.push(LineSite {
                    address: row.address(),
                    file: normalized,
                    line: requested_line,
                    inline_chain: Vec::new(),
                });
            }
        }
    }
    if !saw_lines {
        return Err(ResolutionError::NoLineInfo);
    }
    if !saw_file {
        return Err(ResolutionError::SourceFileNotFound(
            source_suffix.to_owned(),
        ));
    }
    if matched_files.len() > 1 {
        return Err(ResolutionError::SourceFileAmbiguous {
            suffix: source_suffix.to_owned(),
            candidates: matched_files.into_iter().collect(),
        });
    }
    let mut seen = BTreeSet::new();
    sites.retain(|site| seen.insert(site.address));
    if sites.is_empty() {
        return Err(ResolutionError::NoExecutableAddress(
            source_suffix.to_owned(),
        ));
    }
    Ok(sites)
}

fn normalize_path(path: &str) -> String {
    PathBuf::from(path)
        .components()
        .filter_map(|part| match part {
            std::path::Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocationOperation {
    Register(u16),
    FrameOffset(i64),
    AddConstant(i64),
    Dereference { bytes: u8 },
    StackValue,
    Piece { bytes: u8 },
    Unsupported(u8),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LocationError {
    #[error("variable-optimized-out")]
    OptimizedOut,
    #[error("unsupported-location-expression: {0}")]
    Unsupported(String),
    #[error("floating-point-register-unavailable")]
    FloatingPointRegister,
}

pub fn validate_location(operations: &[LocationOperation]) -> Result<(), LocationError> {
    if operations.is_empty() {
        return Err(LocationError::OptimizedOut);
    }
    if operations.len() > liveprobe_native_protocol::MAX_CAPTURE_OPS {
        return Err(LocationError::Unsupported(
            "operation limit exceeded".into(),
        ));
    }
    for operation in operations {
        match operation {
            // The first native target is x86-64. General-purpose DWARF
            // registers are 0..=15; higher numbers include RIP, flags, and
            // floating/vector registers that the approved BPF handler does
            // not expose.
            LocationOperation::Register(register) if *register > 15 => {
                return Err(LocationError::FloatingPointRegister);
            }
            LocationOperation::Dereference { bytes } if !matches!(bytes, 1 | 2 | 4 | 8 | 64) => {
                return Err(LocationError::Unsupported(
                    "dereference width must be 1, 2, 4, 8, or 64".into(),
                ));
            }
            LocationOperation::Piece { bytes } if *bytes == 0 || *bytes > 8 => {
                return Err(LocationError::Unsupported(
                    "piece is not bounded scalar-sized".into(),
                ));
            }
            LocationOperation::Unsupported(opcode) => {
                return Err(LocationError::Unsupported(format!(
                    "DWARF opcode 0x{opcode:02x}"
                )));
            }
            _ => {}
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValueKind {
    Signed,
    Unsigned,
    Boolean,
    Pointer,
    CString,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VariablePlan {
    pub operations: Vec<LocationOperation>,
    pub byte_width: u8,
    pub kind: ValueKind,
}

pub fn resolve_variable(
    path: &Path,
    pc: u64,
    watch_path: &str,
) -> Result<VariablePlan, LocationError> {
    let bytes = fs::read(path).map_err(|error| LocationError::Unsupported(error.to_string()))?;
    let object = object::File::parse(bytes.as_slice())
        .map_err(|error| LocationError::Unsupported(error.to_string()))?;
    let endian = if object.is_little_endian() {
        RunTimeEndian::Little
    } else {
        RunTimeEndian::Big
    };
    let load = |id: SectionId| -> Result<Cow<'_, [u8]>, gimli::Error> {
        Ok(object
            .section_by_name(id.name())
            .and_then(|section| section.uncompressed_data().ok())
            .unwrap_or(Cow::Borrowed(&[])))
    };
    let dwarf_cow =
        Dwarf::load(load).map_err(|error| LocationError::Unsupported(error.to_string()))?;
    let dwarf = dwarf_cow.borrow(|section| EndianSlice::new(section, endian));
    let mut components = watch_path.split('.');
    let root_name = components
        .next()
        .ok_or_else(|| LocationError::Unsupported("empty watch path".into()))?;
    let members: Vec<_> = components.collect();
    let mut units = dwarf.units();
    while let Some(header) = units
        .next()
        .map_err(|error| LocationError::Unsupported(error.to_string()))?
    {
        let unit = dwarf
            .unit(header)
            .map_err(|error| LocationError::Unsupported(error.to_string()))?;
        let mut entries = unit.entries();
        let mut scopes: Vec<(isize, bool, Option<Vec<LocationOperation>>)> = Vec::new();
        while let Some(entry) = entries
            .next_dfs()
            .map_err(|error| LocationError::Unsupported(error.to_string()))?
        {
            let depth = entry.depth();
            while scopes
                .last()
                .is_some_and(|(scope_depth, _, _)| *scope_depth >= depth)
            {
                scopes.pop();
            }
            let parent_active = scopes.last().map(|(_, active, _)| *active).unwrap_or(true);
            let is_scope = matches!(
                entry.tag(),
                gimli::DW_TAG_subprogram
                    | gimli::DW_TAG_inlined_subroutine
                    | gimli::DW_TAG_lexical_block
            );
            let active = if is_scope {
                parent_active && die_contains(&dwarf, &unit, entry, pc)?
            } else {
                parent_active
            };
            if is_scope {
                let frame_base = if active {
                    entry
                        .attr_value(gimli::DW_AT_frame_base)
                        .map(|value| {
                            attribute_expression_at_pc(&dwarf, &unit, value, pc).and_then(
                                |expression| {
                                    decode_frame_base_expression(
                                        expression,
                                        unit.encoding(),
                                        &object,
                                        endian,
                                        pc,
                                    )
                                },
                            )
                        })
                        .transpose()?
                } else {
                    None
                };
                scopes.push((depth, active, frame_base));
            }
            if !active
                || !matches!(
                    entry.tag(),
                    gimli::DW_TAG_variable | gimli::DW_TAG_formal_parameter
                )
            {
                continue;
            }
            if die_name(&dwarf, &unit, entry)?.as_deref() != Some(root_name) {
                continue;
            }
            let type_offset = entry
                .attr_value(gimli::DW_AT_type)
                .and_then(unit_offset)
                .ok_or_else(|| LocationError::Unsupported("variable has no local type".into()))?;
            let (member_offset, scalar_width, final_type) =
                resolve_members(&dwarf, &unit, type_offset, &members)?;
            let kind = classify_type(&dwarf, &unit, final_type)?;
            let width = if kind == ValueKind::CString {
                64
            } else {
                scalar_width
            };
            let location = entry
                .attr_value(gimli::DW_AT_location)
                .ok_or(LocationError::OptimizedOut)?;
            let expression = attribute_expression_at_pc(&dwarf, &unit, location, pc)?;
            let mut operations = decode_expression(expression, unit.encoding())?;
            if operations
                .iter()
                .any(|operation| matches!(operation, LocationOperation::FrameOffset(_)))
            {
                let frame_base = scopes
                    .iter()
                    .rev()
                    .find_map(
                        |(_, active, frame_base)| {
                            if *active { frame_base.as_ref() } else { None }
                        },
                    )
                    .ok_or_else(|| {
                        LocationError::Unsupported(
                            "DW_OP_fbreg has no supported DW_AT_frame_base".into(),
                        )
                    })?;
                operations = apply_frame_base(&operations, frame_base)?;
            }
            if member_offset != 0 {
                if matches!(
                    operations.last(),
                    Some(LocationOperation::Dereference { .. })
                ) {
                    operations.pop();
                }
                operations.push(LocationOperation::AddConstant(member_offset));
                if kind == ValueKind::CString {
                    operations.push(LocationOperation::Dereference { bytes: 8 });
                    operations.push(LocationOperation::Dereference { bytes: 64 });
                } else {
                    operations.push(LocationOperation::Dereference { bytes: width });
                }
            } else if kind == ValueKind::CString {
                match operations.last() {
                    Some(LocationOperation::Register(_)) => {
                        operations.push(LocationOperation::Dereference { bytes: 64 })
                    }
                    Some(LocationOperation::StackValue) => {
                        operations.pop();
                        operations.push(LocationOperation::Dereference { bytes: 64 });
                    }
                    Some(LocationOperation::Dereference { bytes: 8 }) => {
                        operations.push(LocationOperation::Dereference { bytes: 64 })
                    }
                    _ => {
                        operations.push(LocationOperation::Dereference { bytes: 8 });
                        operations.push(LocationOperation::Dereference { bytes: 64 });
                    }
                }
            } else if !matches!(
                operations.last(),
                Some(
                    LocationOperation::Dereference { .. }
                        | LocationOperation::StackValue
                        | LocationOperation::Register(_)
                )
            ) {
                operations.push(LocationOperation::Dereference { bytes: width });
            }
            if matches!(operations.last(), Some(LocationOperation::Register(_))) {
                operations.push(LocationOperation::StackValue);
            }
            validate_location(&operations)?;
            return Ok(VariablePlan {
                operations,
                byte_width: width,
                kind,
            });
        }
    }
    Err(LocationError::Unsupported(format!(
        "variable-not-found: {watch_path}"
    )))
}

fn attribute_expression_at_pc<R: gimli::Reader>(
    dwarf: &Dwarf<R>,
    unit: &gimli::Unit<R>,
    value: AttributeValue<R>,
    pc: u64,
) -> Result<gimli::Expression<R>, LocationError> {
    if let AttributeValue::Exprloc(expression) = value {
        return Ok(expression);
    }
    let mut locations = dwarf
        .attr_locations(unit, value)
        .map_err(|error| LocationError::Unsupported(error.to_string()))?
        .ok_or_else(|| LocationError::Unsupported("unsupported location form".into()))?;
    while let Some(item) = locations
        .next()
        .map_err(|error| LocationError::Unsupported(error.to_string()))?
    {
        if pc >= item.range.begin && pc < item.range.end {
            return Ok(item.data);
        }
    }
    Err(LocationError::OptimizedOut)
}

fn apply_frame_base(
    operations: &[LocationOperation],
    frame_base: &[LocationOperation],
) -> Result<Vec<LocationOperation>, LocationError> {
    validate_frame_base_operations(frame_base)?;
    let mut normalized = Vec::new();
    let mut saw_fbreg = false;
    for operation in operations {
        match operation {
            LocationOperation::FrameOffset(offset) if !saw_fbreg => {
                saw_fbreg = true;
                normalized.extend_from_slice(frame_base);
                if *offset != 0 {
                    normalized.push(LocationOperation::AddConstant(*offset));
                }
            }
            LocationOperation::FrameOffset(_) => {
                return Err(LocationError::Unsupported(
                    "multiple DW_OP_fbreg operations are unsupported".into(),
                ));
            }
            other => normalized.push(other.clone()),
        }
    }
    validate_location(&normalized)?;
    Ok(normalized)
}

fn validate_frame_base_operations(frame_base: &[LocationOperation]) -> Result<(), LocationError> {
    if frame_base.is_empty()
        || !matches!(frame_base.first(), Some(LocationOperation::Register(_)))
        || frame_base
            .iter()
            .skip(1)
            .any(|operation| !matches!(operation, LocationOperation::AddConstant(_)))
    {
        return Err(LocationError::Unsupported(
            "unsupported DW_AT_frame_base expression".into(),
        ));
    }
    validate_location(frame_base)
}

fn decode_frame_base_expression<R: gimli::Reader>(
    expression: gimli::Expression<R>,
    encoding: gimli::Encoding,
    object: &object::File<'_>,
    endian: RunTimeEndian,
    pc: u64,
) -> Result<Vec<LocationOperation>, LocationError> {
    let mut output = Vec::new();
    let mut operations = expression.operations(encoding);
    while let Some(operation) = operations
        .next()
        .map_err(|error| LocationError::Unsupported(error.to_string()))?
    {
        match operation {
            Operation::Register { register } => {
                output.push(LocationOperation::Register(register.0));
            }
            Operation::RegisterOffset {
                register, offset, ..
            } => {
                output.push(LocationOperation::Register(register.0));
                if offset != 0 {
                    output.push(LocationOperation::AddConstant(offset));
                }
            }
            Operation::CallFrameCFA => output.extend(resolve_cfa(object, endian, pc)?),
            Operation::PlusConstant { value } => output.push(LocationOperation::AddConstant(
                i64::try_from(value)
                    .map_err(|_| LocationError::Unsupported("frame-base constant".into()))?,
            )),
            other => {
                return Err(LocationError::Unsupported(format!(
                    "unsupported DW_AT_frame_base operation {other:?}"
                )));
            }
        }
    }
    if output.is_empty()
        || !matches!(output.first(), Some(LocationOperation::Register(_)))
        || output
            .iter()
            .skip(1)
            .any(|operation| !matches!(operation, LocationOperation::AddConstant(_)))
    {
        return Err(LocationError::Unsupported(
            "unsupported DW_AT_frame_base result".into(),
        ));
    }
    validate_location(&output)?;
    Ok(output)
}

fn resolve_cfa(
    object: &object::File<'_>,
    endian: RunTimeEndian,
    pc: u64,
) -> Result<Vec<LocationOperation>, LocationError> {
    if let Some(section) = object.section_by_name(".eh_frame") {
        let data = section
            .uncompressed_data()
            .map_err(|error| LocationError::Unsupported(error.to_string()))?;
        let mut frame = EhFrame::new(data.as_ref(), endian);
        frame.set_address_size(if object.is_64() { 8 } else { 4 });
        let mut bases = BaseAddresses::default().set_eh_frame(section.address());
        if let Some(text) = object.section_by_name(".text") {
            bases = bases.set_text(text.address());
        }
        if let Some(got) = object
            .section_by_name(".got")
            .or_else(|| object.section_by_name(".got.plt"))
        {
            bases = bases.set_got(got.address());
        }
        let mut context = UnwindContext::new();
        if let Ok(row) =
            frame.unwind_info_for_address(&bases, &mut context, pc, EhFrame::cie_from_offset)
        {
            return cfa_rule_operations(row.cfa());
        }
    }
    if let Some(section) = object.section_by_name(".debug_frame") {
        let data = section
            .uncompressed_data()
            .map_err(|error| LocationError::Unsupported(error.to_string()))?;
        let mut frame = DebugFrame::new(data.as_ref(), endian);
        frame.set_address_size(if object.is_64() { 8 } else { 4 });
        let mut context = UnwindContext::new();
        let row = frame
            .unwind_info_for_address(
                &BaseAddresses::default(),
                &mut context,
                pc,
                DebugFrame::cie_from_offset,
            )
            .map_err(|error| {
                LocationError::Unsupported(format!("unsupported CFI for frame base: {error}"))
            })?;
        return cfa_rule_operations(row.cfa());
    }
    Err(LocationError::Unsupported(
        "DW_OP_call_frame_cfa has no usable CFI".into(),
    ))
}

fn cfa_rule_operations<T: gimli::ReaderOffset>(
    rule: &CfaRule<T>,
) -> Result<Vec<LocationOperation>, LocationError> {
    match rule {
        CfaRule::RegisterAndOffset { register, offset } if register.0 <= 15 => {
            let mut operations = vec![LocationOperation::Register(register.0)];
            if *offset != 0 {
                operations.push(LocationOperation::AddConstant(*offset));
            }
            Ok(operations)
        }
        CfaRule::RegisterAndOffset { register, .. } => Err(LocationError::Unsupported(format!(
            "CFA register {} is unavailable",
            register.0
        ))),
        CfaRule::Expression(_) => Err(LocationError::Unsupported(
            "expression-based CFA is unsupported".into(),
        )),
    }
}

fn die_contains<R: gimli::Reader>(
    dwarf: &Dwarf<R>,
    unit: &gimli::Unit<R>,
    entry: &gimli::DebuggingInformationEntry<R>,
    pc: u64,
) -> Result<bool, LocationError> {
    let mut ranges = dwarf
        .die_ranges(unit, entry)
        .map_err(|error| LocationError::Unsupported(error.to_string()))?;
    let mut saw = false;
    while let Some(range) = ranges
        .next()
        .map_err(|error| LocationError::Unsupported(error.to_string()))?
    {
        saw = true;
        if pc >= range.begin && pc < range.end {
            return Ok(true);
        }
    }
    Ok(!saw)
}

fn die_name<R: gimli::Reader>(
    dwarf: &Dwarf<R>,
    unit: &gimli::Unit<R>,
    entry: &gimli::DebuggingInformationEntry<R>,
) -> Result<Option<String>, LocationError> {
    let Some(value) = entry.attr_value(gimli::DW_AT_name) else {
        return Ok(None);
    };
    let reader = dwarf
        .attr_string(unit, value)
        .map_err(|error| LocationError::Unsupported(error.to_string()))?;
    Ok(Some(
        reader
            .to_string_lossy()
            .map_err(|error| LocationError::Unsupported(error.to_string()))?
            .into_owned(),
    ))
}

fn unit_offset<R: gimli::Reader>(value: AttributeValue<R>) -> Option<gimli::UnitOffset<R::Offset>> {
    if let AttributeValue::UnitRef(offset) = value {
        Some(offset)
    } else {
        None
    }
}

fn resolve_members<R: gimli::Reader>(
    dwarf: &Dwarf<R>,
    unit: &gimli::Unit<R>,
    mut type_offset: gimli::UnitOffset<R::Offset>,
    members: &[&str],
) -> Result<(i64, u8, gimli::UnitOffset<R::Offset>), LocationError> {
    let mut total = 0i64;
    for member_name in members {
        loop {
            let entry = unit
                .entry(type_offset)
                .map_err(|error| LocationError::Unsupported(error.to_string()))?;
            if matches!(
                entry.tag(),
                gimli::DW_TAG_typedef
                    | gimli::DW_TAG_const_type
                    | gimli::DW_TAG_volatile_type
                    | gimli::DW_TAG_restrict_type
            ) {
                type_offset = entry
                    .attr_value(gimli::DW_AT_type)
                    .and_then(unit_offset)
                    .ok_or_else(|| {
                        LocationError::Unsupported("type wrapper has no target".into())
                    })?;
            } else {
                break;
            }
        }
        let mut tree = unit
            .entries_tree(Some(type_offset))
            .map_err(|error| LocationError::Unsupported(error.to_string()))?;
        let root = tree
            .root()
            .map_err(|error| LocationError::Unsupported(error.to_string()))?;
        let mut children = root.children();
        let mut found = None;
        while let Some(child) = children
            .next()
            .map_err(|error| LocationError::Unsupported(error.to_string()))?
        {
            let entry = child.entry();
            if entry.tag() != gimli::DW_TAG_member
                || die_name(dwarf, unit, entry)?.as_deref() != Some(*member_name)
            {
                continue;
            }
            let offset = match entry.attr_value(gimli::DW_AT_data_member_location) {
                Some(AttributeValue::Udata(value)) => i64::try_from(value)
                    .map_err(|_| LocationError::Unsupported("member offset".into()))?,
                Some(AttributeValue::Sdata(value)) => value,
                _ => {
                    return Err(LocationError::Unsupported(
                        "non-constant member offset".into(),
                    ));
                }
            };
            let next = entry
                .attr_value(gimli::DW_AT_type)
                .and_then(unit_offset)
                .ok_or_else(|| LocationError::Unsupported("member type".into()))?;
            found = Some((offset, next));
            break;
        }
        let (offset, next) = found.ok_or_else(|| {
            LocationError::Unsupported(format!("variable-not-found: {member_name}"))
        })?;
        total = total
            .checked_add(offset)
            .ok_or_else(|| LocationError::Unsupported("member offset overflow".into()))?;
        type_offset = next;
    }
    let entry = unit
        .entry(type_offset)
        .map_err(|error| LocationError::Unsupported(error.to_string()))?;
    let width = match entry.attr_value(gimli::DW_AT_byte_size) {
        Some(AttributeValue::Udata(value)) => u8::try_from(value)
            .map_err(|_| LocationError::Unsupported("unsupported-type".into()))?,
        _ => 8,
    };
    if !matches!(width, 1 | 2 | 4 | 8) {
        return Err(LocationError::Unsupported("unsupported-type".into()));
    }
    Ok((total, width, type_offset))
}

fn classify_type<R: gimli::Reader>(
    dwarf: &Dwarf<R>,
    unit: &gimli::Unit<R>,
    mut offset: gimli::UnitOffset<R::Offset>,
) -> Result<ValueKind, LocationError> {
    loop {
        let entry = unit
            .entry(offset)
            .map_err(|error| LocationError::Unsupported(error.to_string()))?;
        match entry.tag() {
            gimli::DW_TAG_typedef
            | gimli::DW_TAG_const_type
            | gimli::DW_TAG_volatile_type
            | gimli::DW_TAG_restrict_type => {
                offset = entry
                    .attr_value(gimli::DW_AT_type)
                    .and_then(unit_offset)
                    .ok_or_else(|| {
                        LocationError::Unsupported("unsupported-type: wrapper has no target".into())
                    })?;
            }
            gimli::DW_TAG_enumeration_type => {
                if let Some(next) = entry.attr_value(gimli::DW_AT_type).and_then(unit_offset) {
                    offset = next;
                } else {
                    return Ok(ValueKind::Signed);
                }
            }
            gimli::DW_TAG_pointer_type => {
                let Some(target) = entry.attr_value(gimli::DW_AT_type).and_then(unit_offset) else {
                    return Ok(ValueKind::Pointer);
                };
                return if is_character_type(dwarf, unit, target)? {
                    Ok(ValueKind::CString)
                } else {
                    Ok(ValueKind::Pointer)
                };
            }
            gimli::DW_TAG_base_type => {
                return match entry.attr_value(gimli::DW_AT_encoding) {
                    Some(AttributeValue::Encoding(gimli::DW_ATE_boolean)) => Ok(ValueKind::Boolean),
                    Some(AttributeValue::Encoding(
                        gimli::DW_ATE_signed | gimli::DW_ATE_signed_char,
                    )) => Ok(ValueKind::Signed),
                    Some(AttributeValue::Encoding(
                        gimli::DW_ATE_unsigned
                        | gimli::DW_ATE_unsigned_char
                        | gimli::DW_ATE_address,
                    )) => Ok(ValueKind::Unsigned),
                    _ => Err(LocationError::Unsupported(
                        "unsupported-type: base encoding".into(),
                    )),
                };
            }
            _ => {
                return Err(LocationError::Unsupported(format!(
                    "unsupported-type: {:?}",
                    entry.tag()
                )));
            }
        }
    }
}

fn is_character_type<R: gimli::Reader>(
    dwarf: &Dwarf<R>,
    unit: &gimli::Unit<R>,
    mut offset: gimli::UnitOffset<R::Offset>,
) -> Result<bool, LocationError> {
    loop {
        let entry = unit
            .entry(offset)
            .map_err(|error| LocationError::Unsupported(error.to_string()))?;
        if matches!(
            entry.tag(),
            gimli::DW_TAG_typedef
                | gimli::DW_TAG_const_type
                | gimli::DW_TAG_volatile_type
                | gimli::DW_TAG_restrict_type
        ) {
            offset = entry
                .attr_value(gimli::DW_AT_type)
                .and_then(unit_offset)
                .ok_or_else(|| {
                    LocationError::Unsupported("unsupported-type: character wrapper".into())
                })?;
            continue;
        }
        if entry.tag() != gimli::DW_TAG_base_type {
            return Ok(false);
        }
        return Ok(matches!(
            entry.attr_value(gimli::DW_AT_encoding),
            Some(AttributeValue::Encoding(
                gimli::DW_ATE_signed_char | gimli::DW_ATE_unsigned_char
            ))
        ) || die_name(dwarf, unit, &entry)?.as_deref() == Some("char"));
    }
}

fn decode_expression<R: gimli::Reader>(
    expression: gimli::Expression<R>,
    encoding: gimli::Encoding,
) -> Result<Vec<LocationOperation>, LocationError> {
    let mut output = Vec::new();
    let mut operations = expression.operations(encoding);
    while let Some(operation) = operations
        .next()
        .map_err(|error| LocationError::Unsupported(error.to_string()))?
    {
        let normalized = match operation {
            Operation::Register { register } => LocationOperation::Register(register.0),
            Operation::RegisterOffset {
                register, offset, ..
            } => {
                output.push(LocationOperation::Register(register.0));
                LocationOperation::AddConstant(offset)
            }
            Operation::FrameOffset { offset } => LocationOperation::FrameOffset(offset),
            Operation::PlusConstant { value } => LocationOperation::AddConstant(
                i64::try_from(value).map_err(|_| LocationError::Unsupported("constant".into()))?,
            ),
            Operation::Deref {
                size, space: false, ..
            } => LocationOperation::Dereference { bytes: size },
            Operation::StackValue => LocationOperation::StackValue,
            Operation::Piece {
                size_in_bits,
                bit_offset: None,
            } if size_in_bits % 8 == 0 => LocationOperation::Piece {
                bytes: u8::try_from(size_in_bits / 8)
                    .map_err(|_| LocationError::Unsupported("piece".into()))?,
            },
            _ => {
                return Err(LocationError::Unsupported(format!(
                    "unsupported operation {operation:?}"
                )));
            }
        };
        output.push(normalized);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    #[test]
    fn optimized_out_is_truthful() {
        assert_eq!(validate_location(&[]), Err(LocationError::OptimizedOut));
    }
    #[test]
    fn unsupported_expression_is_truthful() {
        assert!(matches!(
            validate_location(&[LocationOperation::Unsupported(0xe0)]),
            Err(LocationError::Unsupported(_))
        ));
    }
    #[test]
    fn supported_location_forms_validate() {
        assert!(
            validate_location(&[
                LocationOperation::Register(5),
                LocationOperation::AddConstant(8),
                LocationOperation::Dereference { bytes: 8 }
            ])
            .is_ok()
        );
    }

    #[test]
    fn fbreg_requires_a_normalized_register_based_frame_base() {
        let result = apply_frame_base(
            &[LocationOperation::FrameOffset(-8)],
            &[LocationOperation::Dereference { bytes: 8 }],
        );
        assert!(matches!(result, Err(LocationError::Unsupported(_))));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn optimized_c_fbreg_is_normalized_through_cfa_at_the_exact_pc() {
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/fbreg_fixture.c");
        let source = fs::read_to_string(&fixture).unwrap();
        let line = source
            .lines()
            .position(|line| line.contains("FBREG_PROBE_LINE"))
            .map(|line| line as u64 + 1)
            .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("fbreg-fixture");
        let status = Command::new("cc")
            .args([
                "-O1",
                "-g",
                "-fno-omit-frame-pointer",
                "-fno-pie",
                "-no-pie",
                "-Wl,--build-id=sha1",
            ])
            .arg(&fixture)
            .arg("-o")
            .arg(&binary)
            .status()
            .unwrap();
        assert!(status.success());
        let sites = resolve_line(&binary, "fbreg_fixture.c", line).unwrap();
        let resolved = sites
            .iter()
            .find_map(|site| resolve_variable(&binary, site.address, "fbreg_known").ok())
            .expect("fbreg local must resolve at at least one line-program address");
        assert!(matches!(
            resolved.operations.first(),
            Some(LocationOperation::Register(_))
        ));
        assert!(
            resolved
                .operations
                .iter()
                .all(|operation| !matches!(operation, LocationOperation::FrameOffset(_)))
        );
        assert!(
            resolved
                .operations
                .iter()
                .filter(|operation| matches!(operation, LocationOperation::AddConstant(_)))
                .count()
                >= 2
        );
        assert!(matches!(
            resolved.operations.last(),
            Some(LocationOperation::Dereference { bytes: 8 })
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn duplicate_source_suffixes_are_rejected_as_ambiguous() {
        let directory = tempfile::tempdir().unwrap();
        let left = directory.path().join("left/shared");
        let right = directory.path().join("right/shared");
        fs::create_dir_all(&left).unwrap();
        fs::create_dir_all(&right).unwrap();
        let left_source = left.join("probe.c");
        let right_source = right.join("probe.c");
        let main_source = directory.path().join("main.c");
        fs::write(
            &left_source,
            "int left_value(int value) {\n  return value + 1;\n}\n",
        )
        .unwrap();
        fs::write(
            &right_source,
            "int right_value(int value) {\n  return value + 2;\n}\n",
        )
        .unwrap();
        fs::write(
            &main_source,
            "int left_value(int); int right_value(int);\nint main(void) { return left_value(1) + right_value(2); }\n",
        )
        .unwrap();
        let left_object = directory.path().join("left.o");
        let right_object = directory.path().join("right.o");
        let main_object = directory.path().join("main.o");
        for (source, object) in [
            (&left_source, &left_object),
            (&right_source, &right_object),
            (&main_source, &main_object),
        ] {
            assert!(
                Command::new("cc")
                    .args(["-O1", "-g", "-c"])
                    .arg(source)
                    .arg("-o")
                    .arg(object)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let binary = directory.path().join("ambiguous-source");
        assert!(
            Command::new("cc")
                .args(["-Wl,--build-id=sha1"])
                .arg(&left_object)
                .arg(&right_object)
                .arg(&main_object)
                .arg("-o")
                .arg(&binary)
                .status()
                .unwrap()
                .success()
        );
        assert!(matches!(
            resolve_line(&binary, "probe.c", 2),
            Err(ResolutionError::SourceFileAmbiguous { candidates, .. })
                if candidates.len() == 2
        ));
    }
}
