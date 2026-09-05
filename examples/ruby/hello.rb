name = ENV.fetch("NAME", "world")
puts "Hello from Ruby!"
{message: "Hello, #{name}!", squares: (0..5).map { |x| x*x }}
