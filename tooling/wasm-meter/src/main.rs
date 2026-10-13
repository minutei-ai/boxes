use walrus::ir::{
    BinaryOp, Call, Instr, InstrLocId, InstrSeq, InstrSeqId, Loop, Visitor, dfs_in_order,
};
use walrus::{ConstExpr, FunctionBuilder, ModuleConfig, ValType};
#[derive(Default)]
struct Sequences {
    all: Vec<InstrSeqId>,
    loops: Vec<InstrSeqId>,
}
impl<'a> Visitor<'a> for Sequences {
    fn start_instr_seq(&mut self, sequence: &'a InstrSeq) {
        self.all.push(sequence.id());
    }
    fn visit_loop(&mut self, sequence: &Loop) {
        self.loops.push(sequence.seq);
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let (input, output) = args
        .get(1)
        .zip(args.get(2))
        .ok_or("Expected input and output Wasm paths")?;
    let mut module = ModuleConfig::new()
        .generate_name_section(false)
        .generate_producers_section(false)
        .parse_file(input)?;
    let memories: Vec<_> = module.memories.iter().map(|memory| memory.id()).collect();
    if memories.len() != 1 {
        return Err("Meter requires exactly one memory".into());
    }
    let memory = memories[0];
    let fuel = module.globals.add_local(
        ValType::I64,
        true,
        false,
        ConstExpr::Value(walrus::ir::Value::I64(i64::MAX)),
    );
    let pages = module.globals.add_local(
        ValType::I32,
        true,
        false,
        ConstExpr::Value(walrus::ir::Value::I32(1024)),
    );
    module.exports.add("__cirro_fuel", fuel);
    let mut charge = FunctionBuilder::new(&mut module.types, &[], &[]);
    charge
        .func_body()
        .global_get(fuel)
        .i64_const(0)
        .binop(BinaryOp::I64LeS)
        .if_else(
            None,
            |body| {
                body.unreachable();
            },
            |_| {},
        )
        .global_get(fuel)
        .i64_const(1)
        .binop(BinaryOp::I64Sub)
        .global_set(fuel);
    let charge = charge.finish(Vec::new(), &mut module.funcs);
    let amount = module.locals.add(ValType::I32);
    let mut growth = FunctionBuilder::new(&mut module.types, &[ValType::I32], &[ValType::I32]);
    growth
        .func_body()
        .global_get(pages)
        .memory_size(memory)
        .binop(BinaryOp::I32Sub)
        .local_get(amount)
        .binop(BinaryOp::I32LtU)
        .if_else(
            None,
            |body| {
                body.unreachable();
            },
            |_| {},
        )
        .local_get(amount)
        .memory_grow(memory);
    let growth = growth.finish(vec![amount], &mut module.funcs);
    let mut setter = FunctionBuilder::new(&mut module.types, &[ValType::I64, ValType::I32], &[]);
    let input_fuel = module.locals.add(ValType::I64);
    let input_pages = module.locals.add(ValType::I32);
    setter
        .func_body()
        .memory_size(memory)
        .local_get(input_pages)
        .binop(BinaryOp::I32GtU)
        .if_else(
            None,
            |body| {
                body.unreachable();
            },
            |_| {},
        )
        .local_get(input_fuel)
        .global_set(fuel)
        .local_get(input_pages)
        .global_set(pages);
    let setter = setter.finish(vec![input_fuel, input_pages], &mut module.funcs);
    module.exports.add("__cirro_limits", setter);
    for (_, function) in module
        .funcs
        .iter_local_mut()
        .filter(|(id, _)| ![charge, growth, setter].contains(id))
    {
        let mut sequences = Sequences::default();
        sequences.loops.push(function.entry_block());
        dfs_in_order(&mut sequences, function, function.entry_block());
        for id in sequences.all {
            let body = function.block_mut(id);
            for (instruction, _) in &mut body.instrs {
                if matches!(instruction, Instr::MemoryGrow(_)) {
                    *instruction = Call { func: growth }.into();
                }
            }
        }
        for id in sequences.loops {
            function
                .block_mut(id)
                .instrs
                .insert(0, (Call { func: charge }.into(), InstrLocId::default()));
        }
    }
    module.emit_wasm_file(output)?;
    Ok(())
}
