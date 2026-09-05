words = ENV.fetch("WORDS", "hello,world,hello,ruby").split(",")
puts "Grouping with Enumerable"
words.group_by(&:length).transform_values(&:sort)
