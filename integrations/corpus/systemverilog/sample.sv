module counter (
  input logic clock,
  input logic reset,
  output logic [3:0] value
);
  always_ff @(posedge clock) begin
    if (reset) value <= '0;
    else value <= value + 1'b1;
  end
endmodule
